import crypto from "node:crypto";
import type { OAuth2Client } from "googleapis-common";
import type { drive_v3 as DriveV3 } from "googleapis";
import * as cache from "./cache";
import type { CacheData, CacheItem, DirtyItem } from "./cache";
import type { ItemType } from "../types";

type Logger = {
  dbLog: (ctx: string, msg: string, data?: unknown) => void;
  error: (ctx: string, msg: string, data?: unknown) => void;
  success: (ctx: string, msg: string, data?: unknown) => void;
  warn: (ctx: string, msg: string, data?: unknown) => void;
  ipcLog: (ctx: string, msg: string, data?: unknown) => void;
  debug: (ctx: string, msg: string, data?: unknown) => void;
};

// ── Google Drive folder/file constants ──
const VAULT_FOLDER_NAME = "Vault";
const SETTINGS_FILE_NAME = "vault_settings";
const TWOFA_FILE_NAME = "vault_2fa";
const LOGOS_FILE_NAME = "vault_logos";

const SUBFOLDERS = {
  password: "passwords",
  note: "notes",
  job: "jobs",
  totp: "totp",
  settings: "settings",
  sync: "sync",
} as const;

type SubfolderType = keyof typeof SUBFOLDERS;

/**
 * DriveClient — Google Drive storage operations.
 * Each item (password, note, job, TOTP) is stored as a separate encrypted file.
 * Settings, 2FA config, and logo cache are stored as single files.
 * A local cache provides offline support; a dirty queue handles sync retries.
 */
export class DriveClient {
  driveApi: DriveV3.Drive | null = null;
  cache: CacheData;
  private cacheDirty = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncInProgress = false;
  vaultFolderId: string | null = null;
  private subfolderIds: Record<string, string> = {};
  private readonly fileIdCache: Map<string, string> = new Map(); // name -> fileId
  private readonly logger: Logger;
  private readonly googleId: string;
  private readonly encKey: string;
  private closed = false;

  // Debounce: wait 2s after last change before syncing to Drive
  private readonly SYNC_DEBOUNCE_MS = 2000;
  // Max retries for failed Drive operations
  private readonly MAX_RETRIES = 3;

  constructor(googleId: string, encKey: string, logger: Logger) {
    this.googleId = googleId;
    this.encKey = encKey;
    this.logger = logger;
    this.cache = cache.loadCache(googleId);
  }

  /**
   * Initialize the Drive client with an authenticated OAuth2 client.
   * Must be called after Google OAuth succeeds.
   */
  async init(authClient: OAuth2Client): Promise<void> {
    const { google } = await import("googleapis");
    this.driveApi = google.drive({ version: "v3", auth: authClient });
    this.logger.dbLog("drive:init", "Drive client initialized");

    // Ensure the Vault folder exists on Drive
    await this.ensureVaultFolder();

    // Ensure subfolders exist (created once)
    await this.ensureSubfolders();

    // Migrate any flat files from old structure to subfolders
    await this.migrateFlatFiles();

    // Load file ID index from Drive
    await this.buildFileIdCache();

    // On startup: diff local cache vs Drive, resolve conflicts via ETag
    await this.resolveConflicts();

    this.logger.success("drive:init", "Drive client ready", {
      vaultFolderId: this.vaultFolderId,
      cachedFiles: this.fileIdCache.size,
    });
  }

  /**
   * Mark cache as dirty and schedule a debounced sync.
   */
  private markDirty(): void {
    this.cacheDirty = true;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.closed) return;
    this.syncTimer = setTimeout(() => {
      this.syncToDrive().catch((e: unknown) => {
        this.logger.warn("drive:sync", "Debounced sync failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }, this.SYNC_DEBOUNCE_MS);
  }

  /**
   * Flush all pending changes to Google Drive.
   * Processes the dirty queue: creates/updates/deletes files.
   */
  async syncToDrive(): Promise<void> {
    if (!this.driveApi || this.syncInProgress || this.closed) return;
    this.syncInProgress = true;
    this.syncTimer = null;

    try {
      cache.saveCache(this.cache);
      this.cacheDirty = false;

      const queue = [...this.cache.dirtyQueue];
      const remaining = this.processDirtyQueue(queue);

      this.cache.dirtyQueue = remaining;
      this.cache.lastSyncedAt = Date.now();
      cache.saveCache(this.cache);

      if (queue.length > 0) {
        this.logger.dbLog("drive:sync", "Sync complete", {
          processed: queue.length,
          remaining: remaining.length,
        });
      }
    } catch (e: unknown) {
      this.logger.error("drive:sync", "Sync error", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.syncInProgress = false;
    }
  }

  private processDirtyQueue(queue: DirtyItem[]): DirtyItem[] {
    const remaining: DirtyItem[] = [];
    for (const item of queue) {
      if (this.closed) {
        remaining.push(item);
        continue;
      }
      try {
        this.processDirtyItem(item);
      } catch (e: unknown) {
        const err = e instanceof Error ? e.message : String(e);
        this.logger.warn("drive:sync", `Failed to sync item ${item.id}`, {
          error: err,
        });
        item.retryCount++;
        item.lastAttempt = Date.now();
        if (item.retryCount < this.MAX_RETRIES) {
          remaining.push(item);
        } else {
          this.logger.error(
            "drive:sync",
            `Dropping item after ${this.MAX_RETRIES} retries`,
            { itemId: item.id },
          );
        }
      }
    }
    return remaining;
  }

  private async processDirtyItem(item: DirtyItem): Promise<void> {
    if (!this.driveApi) throw new Error("Drive not initialized");

    switch (item.action) {
      case "create":
      case "update": {
        const cacheItem = this.findCacheItem(item.id, item.type);
        if (!cacheItem) throw new Error(`Cache item not found: ${item.id}`);
        const fileName = this.itemFileName(item.id, item.type);
        const content = cacheItem.encryptedData;

        if (item.driveFileId) {
          // Update existing file
          await this.driveApi.files.update({
            fileId: item.driveFileId,
            media: { mimeType: "application/octet-stream", body: content },
            fields: "id, name, modifiedTime",
          });
          this.fileIdCache.set(fileName, item.driveFileId);
        } else {
          // Create new file in the correct subfolder
          const subfolderId = await this.ensureSubfolder(
            SUBFOLDERS[item.type as SubfolderType],
          );
          const created = await this.driveApi.files.create({
            requestBody: {
              name: fileName,
              parents: [subfolderId],
              mimeType: "application/octet-stream",
              appProperties: { itemId: item.id, itemType: item.type },
            },
            media: { mimeType: "application/octet-stream", body: content },
            fields: "id, name, modifiedTime",
          });
          item.driveFileId = created.data.id || undefined;
          this.fileIdCache.set(fileName, item.driveFileId || "");
        }
        break;
      }
      case "delete": {
        if (item.driveFileId) {
          await this.driveApi.files.delete({ fileId: item.driveFileId });
          const fileName = this.itemFileName(item.id, item.type);
          this.fileIdCache.delete(fileName);
        }
        break;
      }
    }
  }

  private findCacheItem(id: string, type: string): CacheItem | null {
    const arr = this.getCacheArray(type);
    return arr.find((i) => i.id === id) || null;
  }

  private getCacheArray(type: string): CacheItem[] {
    switch (type) {
      case "password":
        return this.cache.passwords;
      case "note":
        return this.cache.notes;
      case "job":
        return this.cache.jobs;
      case "totp":
        return this.cache.totp;
      default:
        return [];
    }
  }

  private itemFileName(id: string, type: string): string {
    return `vault_${type}_${id}`;
  }

  private parseItemFileName(name: string): { type: string; id: string } | null {
    const m = /^vault_(password|note|job|totp)_(.+)$/.exec(name);
    if (!m) return null;
    return { type: m[1], id: m[2] };
  }

  // ── Vault folder management ──

  private async ensureVaultFolder(): Promise<void> {
    if (!this.driveApi) throw new Error("Drive not initialized");

    // Search for existing Vault folder
    const res = await this.driveApi.files.list({
      q: `name='${VAULT_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      spaces: "drive",
      fields: "files(id, name)",
    });

    if (res.data.files && res.data.files.length > 0) {
      this.vaultFolderId = res.data.files[0].id || null;
      this.logger.dbLog("drive:folder", "Found existing Vault folder", {
        folderId: this.vaultFolderId,
      });
    } else {
      // Create the Vault folder
      const created = await this.driveApi.files.create({
        requestBody: {
          name: VAULT_FOLDER_NAME,
          mimeType: "application/vnd.google-apps.folder",
        },
        fields: "id",
      });
      this.vaultFolderId = created.data.id || null;
      this.logger.dbLog("drive:folder", "Created Vault folder", {
        folderId: this.vaultFolderId,
      });
    }
  }

  private async ensureSubfolder(name: string): Promise<string> {
    if (this.subfolderIds[name]) return this.subfolderIds[name];
    const res = await this.driveApi!.files.list({
      q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${this.vaultFolderId}' in parents and trashed=false`,
      spaces: "drive",
      fields: "files(id, name)",
    });
    if (res.data.files && res.data.files.length > 0) {
      this.subfolderIds[name] = res.data.files[0].id!;
      this.logger.dbLog("drive:folder", `Found existing subfolder: ${name}`, {
        folderId: this.subfolderIds[name],
      });
    } else {
      const created = await this.driveApi!.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [this.vaultFolderId!],
        },
        fields: "id",
      });
      this.subfolderIds[name] = created.data.id!;
      this.logger.dbLog("drive:folder", `Created subfolder: ${name}`, {
        folderId: this.subfolderIds[name],
      });
    }
    return this.subfolderIds[name];
  }

  private async ensureSubfolders(): Promise<void> {
    for (const name of Object.values(SUBFOLDERS)) {
      if (this.subfolderIds[name]) continue;
      const res = await this.driveApi!.files.list({
        q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${this.vaultFolderId}' in parents and trashed=false`,
        spaces: "drive",
        fields: "files(id, name)",
      });
      if (res.data.files && res.data.files.length > 0) {
        this.subfolderIds[name] = res.data.files[0].id!;
        this.logger.dbLog("drive:folder", `Found existing subfolder: ${name}`, {
          folderId: this.subfolderIds[name],
        });
      } else {
        const created = await this.driveApi!.files.create({
          requestBody: {
            name,
            mimeType: "application/vnd.google-apps.folder",
            parents: [this.vaultFolderId!],
          },
          fields: "id",
        });
        this.subfolderIds[name] = created.data.id!;
        this.logger.dbLog("drive:folder", `Created subfolder: ${name}`, {
          folderId: this.subfolderIds[name],
        });
      }
    }
  }

  /**
   * One-time migration: move files from flat Vault/ root into subfolders.
   * Handles users who had the old flat structure before subfolders were introduced.
   */
  private async migrateFileToSubfolder(
    f: { id?: string | null; name?: string | null },
    subfolderName: string,
    logMsg: string,
  ): Promise<void> {
    const subfolderId = this.subfolderIds[subfolderName];
    if (!subfolderId || !f.id) return;
    await this.driveApi!.files.update({
      fileId: f.id,
      addParents: subfolderId,
      removeParents: this.vaultFolderId!,
      fields: "id, parents",
    });
    this.logger.dbLog("drive:migrate", logMsg);
  }

  private async migrateFlatFiles(): Promise<void> {
    if (!this.driveApi || !this.vaultFolderId) return;

    const res = await this.driveApi.files.list({
      q: `'${this.vaultFolderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`,
      spaces: "drive",
      fields: "files(id, name)",
    });

    const files = res.data.files || [];
    if (files.length === 0) return;

    for (const f of files) {
      const name = f.name || "";
      const parsed = this.parseItemFileName(name);
      if (parsed) {
        const subfolderName = SUBFOLDERS[parsed.type as SubfolderType];
        await this.migrateFileToSubfolder(
          f,
          subfolderName,
          `Moved ${name} → ${subfolderName}/`,
        );
        continue;
      }
      if (name === SETTINGS_FILE_NAME || name === TWOFA_FILE_NAME) {
        await this.migrateFileToSubfolder(
          f,
          SUBFOLDERS.settings,
          `Moved ${name} → settings/`,
        );
        continue;
      }
      if (Object.values(SUBFOLDERS).includes(name as any)) {
        this.logger.dbLog(
          "drive:migrate",
          `Skipping existing subfolder: ${name}`,
        );
        continue;
      }
      this.logger.dbLog(
        "drive:migrate",
        `Unknown file in Vault root, leaving in place: ${name}`,
      );
    }

    // Flush any dirty items generated by the cache after migration
    if (this.cache.dirtyQueue.length > 0) {
      await this.syncToDrive();
    }
  }

  private async cacheSubfolderFiles(subfolderId: string): Promise<void> {
    let pageToken: string | undefined;
    do {
      const res = await this.driveApi!.files.list({
        q: `'${subfolderId}' in parents and trashed=false`,
        spaces: "drive",
        fields: "nextPageToken, files(id, name, modifiedTime, appProperties)",
        pageSize: 1000,
        pageToken,
      });

      for (const f of res.data.files || []) {
        if (f.name && f.id) {
          this.fileIdCache.set(f.name, f.id);
          if (f.modifiedTime) {
            this.cache.etags[f.id] = f.modifiedTime;
          }
        }
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  }

  private async buildFileIdCache(): Promise<void> {
    if (!this.driveApi || !this.vaultFolderId) return;

    for (const [, subfolderId] of Object.entries(this.subfolderIds)) {
      await this.cacheSubfolderFiles(subfolderId);
    }

    this.logger.dbLog("drive:cache", "File ID cache built", {
      count: this.fileIdCache.size,
    });
  }

  /**
   * On startup: compare local cache with Drive files.
   * If Drive has a newer version (different ETag), download and merge.
   */
  private async resolveConflicts(): Promise<void> {
    if (!this.driveApi || !this.vaultFolderId) return;

    this.logger.dbLog("drive:conflict", "Checking for conflicts", {
      lastSyncedAt: this.cache.lastSyncedAt,
      cachedFiles: this.fileIdCache.size,
    });

    // For each file on Drive, check if it's newer than our cache
    for (const [fileName, fileId] of this.fileIdCache) {
      const parsed = this.parseItemFileName(fileName);
      if (!parsed) continue; // Skip non-item files (settings, etc.)

      const driveModified = this.cache.etags[fileId];
      if (!driveModified) continue;

      const localItem = this.findCacheItem(parsed.id, parsed.type);
      if (!localItem) {
        // File exists on Drive but not in local cache — download it
        this.logger.dbLog("drive:conflict", "Downloading missing local item", {
          fileName,
        });
        await this.downloadAndCacheItem(fileId, parsed.id, parsed.type);
      }
    }

    // Process any remaining dirty items from previous session
    if (this.cache.dirtyQueue.length > 0) {
      this.logger.dbLog("drive:conflict", "Processing leftover dirty queue", {
        count: this.cache.dirtyQueue.length,
      });
      await this.syncToDrive();
    }
  }

  private async downloadAndCacheItem(
    fileId: string,
    id: string,
    type: string,
  ): Promise<void> {
    if (!this.driveApi) return;

    const res = await this.driveApi.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );

    const encryptedData = Buffer.from(res.data as ArrayBuffer).toString("utf8");
    const now = new Date().toISOString();
    const item: CacheItem = {
      id,
      sortOrder: 0,
      encryptedData,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const arr = this.getCacheArray(type);
    arr.push(item);
    this.cacheDirty = true;
  }

  // ── CRUD operations ──

  /**
   * Load all non-deleted items of a given type from local cache.
   */
  loadItems(type: ItemType): CacheItem[] {
    const arr = this.getCacheArray(type);
    return arr
      .filter((i) => !i.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /**
   * Load all soft-deleted items of a given type from local cache.
   */
  loadTrash(type: ItemType): CacheItem[] {
    const arr = this.getCacheArray(type);
    return arr
      .filter((i) => !!i.deletedAt)
      .sort((a, b) => (b.deletedAt || "").localeCompare(a.deletedAt || ""));
  }

  /**
   * Save (create or update) an item. Adds to dirty queue for Drive sync.
   */
  saveItem(
    type: "password" | "note" | "job" | "totp",
    encryptedData: string,
    existingId?: string,
    sortOrder?: number,
  ): string {
    const now = new Date().toISOString();

    let returnId: string;
    if (existingId) {
      // Update existing
      returnId = existingId;
      const arr = this.getCacheArray(type);
      const idx = arr.findIndex((i) => i.id === existingId);
      if (idx >= 0) {
        arr[idx].encryptedData = encryptedData;
        arr[idx].updatedAt = now;
        if (sortOrder !== undefined) arr[idx].sortOrder = sortOrder;
      }
      this.cache.dirtyQueue.push({
        id: existingId,
        type,
        action: "update",
        driveFileId:
          this.fileIdCache.get(this.itemFileName(existingId, type)) ||
          undefined,
        retryCount: 0,
        lastAttempt: 0,
      });
    } else {
      // Create new
      returnId = crypto.randomUUID();
      const item: CacheItem = {
        id: returnId,
        sortOrder: sortOrder ?? 0,
        encryptedData,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      const arr = this.getCacheArray(type);
      arr.push(item);
      this.cache.dirtyQueue.push({
        id: returnId,
        type,
        action: "create",
        retryCount: 0,
        lastAttempt: 0,
      });
    }

    this.markDirty();
    cache.saveCache(this.cache);
    return returnId;
  }

  /**
   * Soft-delete an item.
   */
  softDelete(type: "password" | "note" | "job", id: string): void {
    const arr = this.getCacheArray(type);
    const item = arr.find((i) => i.id === id);
    if (item) {
      item.deletedAt = new Date().toISOString();
      item.updatedAt = item.deletedAt;
      this.cache.dirtyQueue.push({
        id,
        type,
        action: "update", // Soft delete = update with deletedAt set
        driveFileId:
          this.fileIdCache.get(this.itemFileName(id, type)) || undefined,
        retryCount: 0,
        lastAttempt: 0,
      });
      this.markDirty();
      cache.saveCache(this.cache);
    }
  }

  /**
   * Restore a soft-deleted item.
   */
  restore(type: "password" | "note" | "job", id: string): void {
    const arr = this.getCacheArray(type);
    const item = arr.find((i) => i.id === id);
    if (item) {
      item.deletedAt = null;
      item.updatedAt = new Date().toISOString();
      this.cache.dirtyQueue.push({
        id,
        type,
        action: "update",
        driveFileId:
          this.fileIdCache.get(this.itemFileName(id, type)) || undefined,
        retryCount: 0,
        lastAttempt: 0,
      });
      this.markDirty();
      cache.saveCache(this.cache);
    }
  }

  /**
   * Permanently delete an item.
   */
  permDelete(type: "password" | "note" | "job" | "totp", id: string): void {
    const arr = this.getCacheArray(type);
    const idx = arr.findIndex((i) => i.id === id);
    if (idx >= 0) {
      arr.splice(idx, 1);
      this.cache.dirtyQueue.push({
        id,
        type,
        action: "delete",
        driveFileId:
          this.fileIdCache.get(this.itemFileName(id, type)) || undefined,
        retryCount: 0,
        lastAttempt: 0,
      });
      this.markDirty();
      cache.saveCache(this.cache);
    }
  }

  /**
   * Update sort order for a list of items.
   */
  updateSortOrder(
    type: "password" | "note" | "job",
    items: Array<{ id?: string }>,
  ): void {
    const arr = this.getCacheArray(type);
    for (let i = 0; i < items.length; i++) {
      if (!items[i].id) continue;
      const item = arr.find((it) => it.id === items[i].id);
      if (item) {
        item.sortOrder = i;
        item.updatedAt = new Date().toISOString();
        this.cache.dirtyQueue.push({
          id: item.id,
          type,
          action: "update",
          driveFileId:
            this.fileIdCache.get(this.itemFileName(item.id, type)) || undefined,
          retryCount: 0,
          lastAttempt: 0,
        });
      }
    }
    this.markDirty();
    cache.saveCache(this.cache);
  }

  // ── Settings ──

  async loadSettings(): Promise<Record<string, unknown> | null> {
    const fileId = this.fileIdCache.get(SETTINGS_FILE_NAME);
    if (!fileId) return null;
    if (!this.driveApi) return this.cache.settings;

    try {
      const res = await this.driveApi.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      const raw = Buffer.from(res.data as ArrayBuffer).toString("utf8");
      // Support both plain JSON (new format) and base64-encoded JSON (legacy)
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        // Legacy: base64-encoded JSON
        data = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      }
      this.cache.settings = data;
      return data;
    } catch {
      return this.cache.settings;
    }
  }

  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    this.cache.settings = settings;
    const content = JSON.stringify(settings, null, 2);

    if (!this.driveApi) {
      cache.saveCache(this.cache);
      return;
    }

    const fileId = this.fileIdCache.get(SETTINGS_FILE_NAME);
    if (fileId) {
      await this.driveApi.files.update({
        fileId,
        media: { mimeType: "application/json", body: content },
      });
    } else {
      const subfolderId = await this.ensureSubfolder(SUBFOLDERS.settings);
      const created = await this.driveApi.files.create({
        requestBody: {
          name: SETTINGS_FILE_NAME,
          parents: [subfolderId],
          mimeType: "application/json",
        },
        media: { mimeType: "application/json", body: content },
        fields: "id",
      });
      if (created.data.id) {
        this.fileIdCache.set(SETTINGS_FILE_NAME, created.data.id);
      }
    }
    cache.saveCache(this.cache);
  }

  // ── 2FA ──

  async load2fa(): Promise<{ secret: string; enabled: boolean } | null> {
    const fileId = this.fileIdCache.get(TWOFA_FILE_NAME);
    if (!fileId)
      return this.cache.twofa
        ? { secret: this.cache.twofa.secret, enabled: this.cache.twofa.enabled }
        : null;
    if (!this.driveApi)
      return this.cache.twofa
        ? { secret: this.cache.twofa.secret, enabled: this.cache.twofa.enabled }
        : null;

    try {
      const res = await this.driveApi.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      const data = JSON.parse(
        Buffer.from(res.data as ArrayBuffer).toString("utf8"),
      );
      this.cache.twofa = { secret: data.secret, enabled: data.enabled };
      return data;
    } catch {
      return this.cache.twofa
        ? { secret: this.cache.twofa.secret, enabled: this.cache.twofa.enabled }
        : null;
    }
  }

  async save2fa(secret: string, enabled: boolean): Promise<void> {
    this.cache.twofa = { secret, enabled };
    const content = JSON.stringify({ secret, enabled }, null, 2);

    if (!this.driveApi) {
      cache.saveCache(this.cache);
      return;
    }

    const fileId = this.fileIdCache.get(TWOFA_FILE_NAME);
    if (fileId) {
      await this.driveApi.files.update({
        fileId,
        media: { mimeType: "application/json", body: content },
      });
    } else {
      const subfolderId = await this.ensureSubfolder(SUBFOLDERS.settings);
      const created = await this.driveApi.files.create({
        requestBody: {
          name: TWOFA_FILE_NAME,
          parents: [subfolderId],
          mimeType: "application/json",
        },
        media: { mimeType: "application/json", body: content },
        fields: "id",
      });
      if (created.data.id) {
        this.fileIdCache.set(TWOFA_FILE_NAME, created.data.id);
      }
    }
    cache.saveCache(this.cache);
  }

  // ── Logo cache ──

  async loadLogos(): Promise<cache.CacheLogo[]> {
    return this.cache.logos;
  }

  async saveLogo(domain: string, url: string): Promise<void> {
    const now = new Date().toISOString();
    const idx = this.cache.logos.findIndex((l) => l.domain === domain);
    if (idx >= 0) {
      this.cache.logos[idx] = { domain, url, cachedAt: now };
    } else {
      this.cache.logos.push({ domain, url, cachedAt: now });
    }
    this.markDirty();
    cache.saveCache(this.cache);
  }

  // ── Cleanup ──

  /**
   * Force-flush any pending sync and stop the debounce timer.
   * Call on app close.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    await this.syncToDrive();
    cache.saveCache(this.cache);
  }
}
