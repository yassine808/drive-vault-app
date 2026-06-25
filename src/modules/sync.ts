import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import type { DriveClient } from "./drive";
import type { Session, SyncFolder, SyncFolderState, SyncConfig } from "../types";
import type Electron from "electron";

type Logger = {
  dbLog: (ctx: string, msg: string, data?: unknown) => void;
  success: (ctx: string, msg: string, data?: unknown) => void;
  warn: (ctx: string, msg: string, data?: unknown) => void;
  ipcLog: (ctx: string, msg: string, data?: unknown) => void;
  error: (ctx: string, msg: string, data?: unknown) => void;
  debug: (ctx: string, msg: string, data?: unknown) => void;
};
type LogError = (ctx: string, err: unknown) => void;
type IpcHandler = (...args: any[]) => any;
type AuthWrapper = (fn: IpcHandler) => IpcHandler;

// ── Constants ──
const SYNC_CONFIG_FILE = "sync_config.json";
const SYNC_STATE_FILE = "sync_state.json";
const SYNC_DRIVE_FOLDER = "sync";
const FILE_WATCH_DEBOUNCE_MS = 2000;

// Files to ignore during sync
const IGNORE_PATTERNS = [
  /^\./, // hidden files
  /\.tmp$/i, // temp files
  /~$/, // backup files
  /~$/, // lock files
  /^~\$/, // Office lock files
  /\.DS_Store$/i, // macOS
  /^Thumbs\.db$/i, // Windows
  /^desktop\.ini$/i, // Windows
];

// ── Helpers ──

function getCacheDir(): string {
  return path.join(os.homedir(), "AppData", "Roaming", "Vault", "Cache");
}

function getConfigPath(): string {
  return path.join(getCacheDir(), SYNC_CONFIG_FILE);
}

function getStatePath(): string {
  return path.join(getCacheDir(), SYNC_STATE_FILE);
}

function shouldIgnore(fileName: string): boolean {
  return IGNORE_PATTERNS.some((p) => p.test(fileName));
}

const RESERVED_NAMES_WINDOWS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function sanitizeDriveFolderName(name: string): string {
  if (typeof name !== "string") {
    throw new TypeError("Folder name must be a string");
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Folder name cannot be empty");
  }
  if (trimmed.length > 128) {
    throw new Error("Folder name cannot exceed 128 characters");
  }

  // Check for reserved names (Windows)
  const baseName = trimmed.split(".")[0].toUpperCase();
  if (RESERVED_NAMES_WINDOWS.has(baseName)) {
    throw new Error(`"${trimmed}" is a reserved folder name`);
  }

  // Remove dangerous characters
  let sanitized = trimmed.replace(/[\\/<>:|"?*\x00-\x1f]/g, "_");

  // Prevent directory traversal patterns
  sanitized = sanitized.replace(/\.{2,}/g, "_");

  return sanitized;
}

/**
 * Validate a sync folder path: resolve symlinks, check it's within the
 * user's home directory, and block sensitive system paths.
 */
function validateSyncPath(inputPath: string): {
  ok: boolean;
  error?: string;
  realPath?: string;
} {
  try {
    // Resolve symlinks and normalize
    const realPath = fs.realpathSync(inputPath);

    // Check exists and is directory
    const stat = fs.statSync(realPath);
    if (!stat.isDirectory()) {
      return { ok: false, error: "Path must be a directory" };
    }

    // Whitelist: only home directory and common user folders
    const homeDir = os.homedir();
    if (!realPath.startsWith(homeDir)) {
      return {
        ok: false,
        error: "Can only sync folders within your home directory",
      };
    }

    // Blacklist: sensitive system paths (cross-platform)
    const forbidden =
      process.platform === "win32"
        ? [
            String.raw`C:\Windows`,
            String.raw`C:\Program Files`,
            String.raw`C:\Program Files (x86)`,
            String.raw`C:\ProgramData`,
            String.raw`C:\$Recycle.Bin`,
            path.join(homeDir, String.raw`AppData\Roaming\Microsoft`),
            path.join(homeDir, String.raw`AppData\Local\Temp`),
          ]
        : [
            "/System",
            "/Library",
            "/etc",
            "/var",
            "/usr/bin",
            "/usr/local/bin",
            path.join(homeDir, ".ssh"),
            path.join(homeDir, ".gnupg"),
            path.join(homeDir, ".aws"),
          ];

    if (forbidden.some((f) => realPath.startsWith(path.resolve(f)))) {
      return { ok: false, error: "Cannot sync restricted system directories" };
    }

    return { ok: true, realPath };
  } catch {
    return { ok: false, error: "Invalid path or access denied" };
  }
}

async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function walkDir(
  dir: string,
  localPath: string,
  includeSet: Set<string> | null,
  result: Map<string, { hash: string; mtime: number }>,
): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDirDirEntry(fullPath, localPath, includeSet, result);
      continue;
    }
    if (!entry.isFile()) continue;
    await walkDirFileEntry(fullPath, localPath, includeSet, result);
  }
}

async function walkDirDirEntry(
  fullPath: string,
  localPath: string,
  includeSet: Set<string> | null,
  result: Map<string, { hash: string; mtime: number }>,
): Promise<void> {
  if (includeSet) {
    const relDir = path.relative(localPath, fullPath).replaceAll("\\", "/");
    const prefix = relDir ? relDir + "/" : "";
    if (![...includeSet].some((p) => p.startsWith(prefix))) return;
  }
  await walkDir(fullPath, localPath, includeSet, result);
}

async function walkDirFileEntry(
  fullPath: string,
  localPath: string,
  includeSet: Set<string> | null,
  result: Map<string, { hash: string; mtime: number }>,
): Promise<void> {
  const relPath = path.relative(localPath, fullPath).replaceAll("\\", "/");
  if (includeSet && !includeSet.has(relPath)) return;
  try {
    const stat = await fs.promises.stat(fullPath);
    const hash = await computeFileHash(fullPath);
    result.set(relPath, { hash, mtime: stat.mtimeMs });
  } catch {
    // skip unreadable files
  }
}

async function walkLocalFiles(
  localPath: string,
  includePaths?: string[],
): Promise<Map<string, { hash: string; mtime: number }>> {
  const result = new Map<string, { hash: string; mtime: number }>();
  const includeSet = includePaths?.length
    ? new Set(includePaths.map((p) => p.replaceAll("\\", "/")))
    : null;
  await walkDir(localPath, localPath, includeSet, result);
  return result;
}

function escapeDriveQueryValue(value: string): string {
  return value.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`);
}

// ── State persistence ──

function loadConfig(): SyncConfig {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      folders: (parsed.folders || []).map((folder: SyncFolder) => ({
        ...folder,
        includePaths: Array.isArray(folder.includePaths) ? folder.includePaths : undefined,
      })),
      globalState: "idle",
      lastFullSyncAt: parsed.lastFullSyncAt || null,
    };
  } catch {
    return { folders: [], globalState: "idle", lastFullSyncAt: null };
  }
}

function saveConfig(config: SyncConfig): void {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify(
      {
        version: 1,
        folders: config.folders,
        lastFullSyncAt: config.lastFullSyncAt,
      },
      null,
      2,
    ),
  );
}

function loadState(): Record<string, SyncFolderState> {
  try {
    const raw = fs.readFileSync(getStatePath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveState(state: Record<string, SyncFolderState>): void {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

// ── File watcher ──

class FileWatcher {
  private readonly watchers: Map<string, fs.FSWatcher> = new Map();
  private readonly timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly onChange: (folderId: string) => void;

  constructor(onChange: (folderId: string) => void) {
    this.onChange = onChange;
  }

  watch(folderId: string, localPath: string): void {
    this.unwatch(folderId);
    try {
      const watcher = fs.watch(localPath, { recursive: true }, () => {
        // Debounce
        const existing = this.timers.get(folderId);
        if (existing) clearTimeout(existing);
        this.timers.set(
          folderId,
          setTimeout(() => {
            this.timers.delete(folderId);
            this.onChange(folderId);
          }, FILE_WATCH_DEBOUNCE_MS),
        );
      });
      this.watchers.set(folderId, watcher);
    } catch {
      // fs.watch may fail on some paths — rely on manual sync
    }
  }

  unwatch(folderId: string): void {
    const w = this.watchers.get(folderId);
    if (w) {
      try {
        w.close();
      } catch {
        /* noop */
      }
      this.watchers.delete(folderId);
    }
    const t = this.timers.get(folderId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(folderId);
    }
  }

  destroy(): void {
    for (const id of this.watchers.keys()) this.unwatch(id);
  }
}

// ── Sync engine ──

class SyncEngine {
  private drive: DriveClient | null = null;
  private syncFolderId: string | null = null;
  private readonly fileWatcher: FileWatcher;
  private readonly syncingFolders: Set<string> = new Set();

  constructor(driveClient: DriveClient | null) {
    this.drive = driveClient;
    this.fileWatcher = new FileWatcher((folderId) => {
      this.syncFolder(folderId).catch(() => {});
    });
  }

  setDriveClient(driveClient: DriveClient | null): void {
    this.drive = driveClient;
  }

  // Get or create the Vault/sync folder on Drive.
  private async getSyncFolderId(): Promise<string | null> {
    if (!this.drive?.driveApi) return null;
    if (this.syncFolderId) return this.syncFolderId;

    const vaultFolderId = this.drive.vaultFolderId;
    if (!vaultFolderId) return null;

    const drive = this.drive?.driveApi;
    const res = await drive.files.list({
      q: `name='${escapeDriveQueryValue(SYNC_DRIVE_FOLDER)}' and mimeType='application/vnd.google-apps.folder' and '${vaultFolderId}' in parents and trashed=false`,
      spaces: "drive",
      fields: "files(id, name)",
    });

    const existing = res.data.files?.[0];
    if (existing?.id) {
      this.syncFolderId = existing.id;
      return this.syncFolderId;
    }

    const created = await drive.files.create({
      requestBody: {
        name: SYNC_DRIVE_FOLDER,
        mimeType: "application/vnd.google-apps.folder",
        parents: [vaultFolderId],
      },
      fields: "id",
    });
    this.syncFolderId = created.data.id!;
    return this.syncFolderId;
  }

  // Get or create a subfolder inside Vault/sync/ for a sync folder
  private async getDriveSubfolderId(driveFolderName: string): Promise<string | null> {
    const syncFolderId = await this.getSyncFolderId();
    if (!syncFolderId || !this.drive) return null;
    if (!driveFolderName) return syncFolderId;

    const drive = this.drive?.driveApi;
    if (!drive) return null;
    const res = await drive.files.list({
      q: `name='${escapeDriveQueryValue(driveFolderName)}' and mimeType='application/vnd.google-apps.folder' and '${syncFolderId}' in parents and trashed=false`,
      spaces: "drive",
      fields: "files(id, name)",
    });

    const existing = res.data.files?.[0];
    if (existing?.id) {
      return existing.id;
    }

    const created = await drive.files.create({
      requestBody: {
        name: driveFolderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [syncFolderId],
      },
      fields: "id",
    });
    return created.data.id!;
  }

  private async scanDriveFiles(
    driveSubfolderId: string,
  ): Promise<Map<string, { fileId: string; modifiedTime: string; hash: string | null }>> {
    const driveFiles = new Map<
      string,
      { fileId: string; modifiedTime: string; hash: string | null }
    >();
    const drive = this.drive?.driveApi;
    let pageToken: string | undefined;
    do {
      const res: any = await drive!.files.list({
        q: `'${driveSubfolderId}' in parents and trashed=false`,
        spaces: "drive",
        fields: "nextPageToken, files(id, name, modifiedTime, appProperties)",
        pageSize: 1000,
        pageToken,
      });
      for (const f of res.data.files || []) {
        if (f.name && f.id) {
          driveFiles.set(f.name, {
            fileId: f.id,
            modifiedTime: f.modifiedTime || "",
            hash: f.appProperties?.contentHash || null,
          });
        }
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
    return driveFiles;
  }

  private async resolveConflict(
    relPath: string,
    drive: { fileId: string; modifiedTime: string; hash: string | null },
    local: { hash: string },
    folder: SyncFolder,
    driveSubfolderId: string,
    newState: SyncFolderState,
  ): Promise<{
    uploaded: number;
    downloaded: number;
    errors: number;
    resolved: boolean;
  }> {
    let uploaded = 0,
      downloaded = 0,
      errors = 0,
      resolved = false;
    try {
      const conflictName = this.addConflictSuffix(relPath);
      await this.downloadFile(drive.fileId, path.join(folder.localPath, conflictName));
      newState.files[conflictName] = {
        relativePath: conflictName,
        localHash: drive.hash,
        localMtime: Date.now(),
        driveFileId: drive.fileId,
        driveModifiedTime: drive.modifiedTime,
        driveHash: drive.hash,
        conflict: "none",
      };
      downloaded++;
      resolved = true;
    } catch {
      errors++;
    }
    try {
      await this.uploadFile(
        path.join(folder.localPath, relPath),
        relPath,
        driveSubfolderId,
        local.hash,
      );
      uploaded++;
    } catch {
      errors++;
    }
    return { uploaded, downloaded, errors, resolved };
  }

  private async syncFileChange(opts: {
    relPath: string;
    local: { hash: string; mtime?: number } | null;
    drive: { fileId: string; modifiedTime: string; hash: string | null } | null;
    prev: SyncFolderState["files"][string] | null;
    folder: SyncFolder;
    driveSubfolderId: string;
    driveFiles: Map<string, { fileId: string; modifiedTime: string; hash: string | null }>;
    newState: SyncFolderState;
    counters: {
      uploaded: number;
      downloaded: number;
      conflicts: number;
      errors: number;
    };
  }): Promise<void> {
    const {
      relPath,
      local,
      drive,
      prev,
      folder,
      driveSubfolderId,
      driveFiles,
      newState,
      counters,
    } = opts;
    newState.files[relPath] = {
      relativePath: relPath,
      localHash: local?.hash || null,
      localMtime: local?.mtime || null,
      driveFileId: drive?.fileId || null,
      driveModifiedTime: drive?.modifiedTime || null,
      driveHash: drive?.hash || null,
      conflict: "none",
    };

    const localChanged = !prev || prev.localHash !== local?.hash;
    const driveChanged = !prev || prev.driveHash !== drive?.hash;

    if (localChanged && driveChanged && local && drive) {
      newState.files[relPath].conflict = "both";
      counters.conflicts++;
      const r = await this.resolveConflict(
        relPath,
        drive,
        local,
        folder,
        driveSubfolderId,
        newState,
      );
      counters.uploaded += r.uploaded;
      counters.downloaded += r.downloaded;
      counters.errors += r.errors;
      if (!r.resolved) newState.files[relPath].conflict = "both";
      return;
    }
    if (localChanged && local) {
      await this.syncLocalChanged(relPath, local, folder, driveSubfolderId, driveFiles, counters);
      return;
    }
    if (driveChanged && drive) {
      await this.syncDriveChanged(relPath, drive, folder, counters);
      return;
    }
    await this.handleDeletedFileSync(relPath, local, drive, prev, folder, counters, newState);
  }

  private async handleDeletedFileSync(
    relPath: string,
    local: { hash: string; mtime?: number } | null,
    drive: { fileId: string; modifiedTime: string; hash: string | null } | null,
    prev: SyncFolderState["files"][string] | null,
    folder: SyncFolder,
    counters: {
      uploaded: number;
      downloaded: number;
      conflicts: number;
      errors: number;
    },
    _newState: SyncFolderState,
  ): Promise<void> {
    if (!local && drive && prev && this.drive?.driveApi) {
      try {
        await this.drive.driveApi.files.delete({ fileId: drive.fileId });
      } catch {
        counters.errors++;
      }
      return;
    }
    if (!drive && local && prev) {
      try {
        await fs.promises.unlink(path.join(folder.localPath, relPath));
      } catch {
        counters.errors++;
      }
    }
  }

  private async syncLocalChanged(
    relPath: string,
    local: { hash: string; mtime?: number },
    folder: SyncFolder,
    driveSubfolderId: string,
    driveFiles: Map<string, { fileId: string; modifiedTime: string; hash: string | null }>,
    counters: { uploaded: number; errors: number },
  ): Promise<void> {
    try {
      const existingDrive = driveFiles.get(relPath);
      if (existingDrive) {
        await this.updateFile(
          existingDrive.fileId,
          path.join(folder.localPath, relPath),
          local.hash,
        );
      } else {
        await this.uploadFile(
          path.join(folder.localPath, relPath),
          relPath,
          driveSubfolderId,
          local.hash,
        );
      }
      counters.uploaded++;
    } catch {
      counters.errors++;
    }
  }

  private async syncDriveChanged(
    relPath: string,
    drive: { fileId: string; modifiedTime: string; hash: string | null },
    folder: SyncFolder,
    counters: { downloaded: number; errors: number },
  ): Promise<void> {
    try {
      await this.downloadFile(drive.fileId, path.join(folder.localPath, relPath));
      counters.downloaded++;
    } catch {
      counters.errors++;
    }
  }

  // ── Two-way sync for one folder ──
  async syncFolder(folderId: string): Promise<{
    uploaded: number;
    downloaded: number;
    conflicts: number;
    errors: number;
  }> {
    const config = loadConfig();
    const folder = config.folders.find((f) => f.id === folderId);
    if (!folder?.enabled) return { uploaded: 0, downloaded: 0, conflicts: 0, errors: 0 };
    if (this.syncingFolders.has(folderId))
      return { uploaded: 0, downloaded: 0, conflicts: 0, errors: 0 };

    this.syncingFolders.add(folderId);
    folder.status = "syncing";
    saveConfig(config);

    let uploaded = 0,
      downloaded = 0,
      conflicts = 0,
      errors = 0;

    try {
      if (!this.drive?.driveApi) {
        throw new Error("Drive not initialized");
      }

      const driveSubfolderId = await this.getDriveSubfolderId(folder.driveFolderName);
      if (!driveSubfolderId) throw new Error("Could not access Drive sync folder");

      const localFiles = await walkLocalFiles(folder.localPath, folder.includePaths);

      const driveFiles = await this.scanDriveFiles(driveSubfolderId);

      const state = loadState();
      const folderState: SyncFolderState = state[folderId] || {
        folderId,
        files: {},
      };
      const allPaths = new Set([
        ...localFiles.keys(),
        ...driveFiles.keys(),
        ...Object.keys(folderState.files),
      ]);

      const newState: SyncFolderState = { folderId, files: {} };
      const counters = { uploaded, downloaded, conflicts, errors };

      for (const relPath of allPaths) {
        const local = localFiles.get(relPath) || null;
        const drive = driveFiles.get(relPath) || null;
        const prev = folderState.files[relPath] || null;
        await this.syncFileChange({
          relPath,
          local,
          drive,
          prev,
          folder,
          driveSubfolderId,
          driveFiles,
          newState,
          counters,
        });
      }

      uploaded = counters.uploaded;
      downloaded = counters.downloaded;
      conflicts = counters.conflicts;
      errors = counters.errors;

      this.cleanupEmptyDirs(folder.localPath);

      state[folderId] = newState;
      saveState(state);

      const hasConflicts = Object.values(newState.files).some((f) => f.conflict !== "none");
      if (errors > 0) {
        folder.status = "error";
        folder.errorMessage = `${errors} error(s)`;
      } else if (hasConflicts) {
        folder.status = "conflict";
      } else {
        folder.status = "idle";
      }
      folder.lastSyncAt = Date.now();
      saveConfig(config);
    } catch (e) {
      errors++;
      folder.status = "error";
      folder.errorMessage = e instanceof Error ? e.message : String(e);
      folder.lastSyncAt = Date.now();
      saveConfig(config);
    } finally {
      this.syncingFolders.delete(folderId);
    }

    return { uploaded, downloaded, conflicts, errors };
  }

  private addConflictSuffix(relPath: string): string {
    const ext = path.extname(relPath);
    const base = relPath.slice(0, -ext.length) || relPath;
    return `${base} (drive)${ext}`;
  }

  private async uploadFile(
    localPath: string,
    driveFileName: string,
    parentFolderId: string,
    contentHash: string,
  ): Promise<void> {
    const drive = this.drive?.driveApi;
    if (!drive) return;
    const content = fs.createReadStream(localPath);
    await drive.files.create({
      requestBody: {
        name: driveFileName,
        parents: [parentFolderId],
        mimeType: "application/octet-stream",
        appProperties: { contentHash },
      },
      media: { mimeType: "application/octet-stream", body: content },
      fields: "id",
    });
  }

  private async updateFile(fileId: string, localPath: string, contentHash: string): Promise<void> {
    const drive = this.drive?.driveApi;
    if (!drive) return;
    const content = fs.createReadStream(localPath);
    await drive.files.update({
      fileId,
      media: { mimeType: "application/octet-stream", body: content },
      fields: "id",
    });
    // Update appProperties with new hash via a separate patch call
    await drive.files.update({
      fileId,
      requestBody: { appProperties: { contentHash } },
      fields: "id",
    });
  }

  private async downloadFile(fileId: string, localPath: string): Promise<void> {
    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB limit

    const drive = this.drive?.driveApi;
    if (!drive) return;
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const data = Buffer.from(res.data as ArrayBuffer);

    if (data.length > MAX_FILE_SIZE) {
      throw new Error(`File size ${data.length} exceeds maximum ${MAX_FILE_SIZE}`);
    }

    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Write to temp file first, then atomic rename
    const tempPath = `${localPath}.tmp`;
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, localPath);
  }

  private cleanupEmptyDirs(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          this.cleanupEmptyDirs(path.join(dir, entry.name));
        }
      }
      // Try to remove if empty (will fail if not empty, which is fine)
      if (fs.readdirSync(dir).length === 0 && dir !== path.dirname(dir)) {
        fs.rmdirSync(dir);
      }
    } catch {
      // ignore — best-effort cleanup
    }
  }

  // ── Folder management ──

  addFolder(localPath: string, driveFolderName: string, includePaths?: string[]): SyncFolder {
    const config = loadConfig();
    const folder: SyncFolder = {
      id: crypto.randomUUID(),
      localPath: path.resolve(localPath),
      driveFolderName: driveFolderName ? sanitizeDriveFolderName(driveFolderName) : "",
      includePaths,
      enabled: true,
      lastSyncAt: null,
      status: "idle",
    };
    config.folders.push(folder);
    saveConfig(config);
    this.fileWatcher.watch(folder.id, folder.localPath);
    return folder;
  }

  removeFolder(folderId: string): void {
    const config = loadConfig();
    if (config.folders.some((f) => f.id === folderId)) {
      this.fileWatcher.unwatch(folderId);
      // Remove state
      const state = loadState();
      delete state[folderId];
      saveState(state);
    }
    config.folders = config.folders.filter((f) => f.id !== folderId);
    saveConfig(config);
  }

  toggleFolder(folderId: string, enabled: boolean): void {
    const config = loadConfig();
    const folder = config.folders.find((f) => f.id === folderId);
    if (folder) {
      folder.enabled = enabled;
      if (enabled) {
        this.fileWatcher.watch(folderId, folder.localPath);
      } else {
        this.fileWatcher.unwatch(folderId);
      }
      saveConfig(config);
    }
  }

  getConfig(): SyncConfig {
    return loadConfig();
  }

  getFolderState(folderId: string): SyncFolderState | null {
    const state = loadState();
    return state[folderId] || null;
  }

  getAllFolderStates(): Record<string, SyncFolderState> {
    return loadState();
  }

  // Start watching all enabled folders
  startWatching(): void {
    const config = loadConfig();
    for (const folder of config.folders) {
      if (folder.enabled) {
        this.fileWatcher.watch(folder.id, folder.localPath);
      }
    }
  }

  destroy(): void {
    this.fileWatcher.destroy();
  }
}

// ── Module registration ──

export function register(
  ipcMain: Electron.IpcMain,
  requireAuth: AuthWrapper,
  requireAuthNoArgs: AuthWrapper,
  driveClient: DriveClient | null,
  getSession: () => Session | null,
  logger: Logger,
  logError: LogError,
) {
  const engine = new SyncEngine(driveClient);

  // Re-init drive client when it changes (e.g., after reauth)
  const updateDriveClient = (dc: DriveClient | null) => {
    engine.setDriveClient(dc);
    if (dc) engine.startWatching();
  };
  // Store reference for later updates
  (globalThis as any).__syncEngine = engine;

  ipcMain.handle(
    "sync:folders:list",
    requireAuthNoArgs(async () => {
      try {
        return { ok: true, folders: engine.getConfig().folders };
      } catch (e) {
        logError("sync:folders:list", e);
        return { ok: false, error: "Failed to list sync folders" };
      }
    }),
  );

  ipcMain.handle(
    "sync:folders:add",
    requireAuth(
      async (
        _e,
        { localPath, driveFolderName }: { localPath: string; driveFolderName: string },
      ) => {
        logger.ipcLog("sync:folders:add", "Adding sync folder", {
          localPath,
          driveFolderName,
        });
        try {
          // Validate and sanitize folder name
          const sanitizedName = sanitizeDriveFolderName(
            driveFolderName || path.basename(localPath),
          );

          // Validate path: resolve symlinks, check home dir, block system paths
          const validation = validateSyncPath(localPath);
          if (!validation.ok) {
            return { ok: false, error: validation.error };
          }

          const folder = engine.addFolder(validation.realPath!, sanitizedName);
          logger.success("sync:folders:add", "Sync folder added", {
            id: folder.id,
            path: validation.realPath,
          });
          return { ok: true, folder };
        } catch (e) {
          logError("sync:folders:add", e);
          return {
            ok: false,
            error: e instanceof Error ? e.message : "Failed to add sync folder",
          };
        }
      },
    ),
  );

  ipcMain.handle(
    "sync:folders:remove",
    requireAuth(async (_e, { folderId }: { folderId: string }) => {
      logger.ipcLog("sync:folders:remove", "Removing sync folder", {
        folderId,
      });
      try {
        engine.removeFolder(folderId);
        logger.success("sync:folders:remove", "Sync folder removed");
        return { ok: true };
      } catch (e) {
        logError("sync:folders:remove", e);
        return { ok: false, error: "Failed to remove sync folder" };
      }
    }),
  );

  ipcMain.handle(
    "sync:folders:toggle",
    requireAuth(async (_e, { folderId, enabled }: { folderId: string; enabled: boolean }) => {
      logger.ipcLog("sync:folders:toggle", "Toggling sync folder", {
        folderId,
        enabled,
      });
      try {
        engine.toggleFolder(folderId, enabled);
        logger.success("sync:folders:toggle", "Sync folder toggled");
        return { ok: true };
      } catch (e) {
        logError("sync:folders:toggle", e);
        return { ok: false, error: "Failed to toggle sync folder" };
      }
    }),
  );

  ipcMain.handle(
    "sync:status",
    requireAuthNoArgs(async () => {
      try {
        return { ok: true, config: engine.getConfig() };
      } catch (e) {
        logError("sync:status", e);
        return { ok: false, error: "Failed to get sync status" };
      }
    }),
  );

  ipcMain.handle(
    "sync:now",
    requireAuth(async () => {
      logger.ipcLog("sync:now", "Manual sync triggered");
      try {
        const config = engine.getConfig();
        let totalUploaded = 0,
          totalDownloaded = 0,
          totalConflicts = 0,
          totalErrors = 0;
        for (const folder of config.folders) {
          if (!folder.enabled) continue;
          const result = await engine.syncFolder(folder.id);
          totalUploaded += result.uploaded;
          totalDownloaded += result.downloaded;
          totalConflicts += result.conflicts;
          totalErrors += result.errors;
        }
        logger.success("sync:now", "Sync complete", {
          uploaded: totalUploaded,
          downloaded: totalDownloaded,
          conflicts: totalConflicts,
          errors: totalErrors,
        });
        if (totalErrors > 0) {
          const error = `Sync failed with ${totalErrors} error(s)`;
          return {
            ok: false,
            error,
            uploaded: totalUploaded,
            downloaded: totalDownloaded,
            conflicts: totalConflicts,
            errors: totalErrors,
          };
        }
        return {
          ok: true,
          uploaded: totalUploaded,
          downloaded: totalDownloaded,
          conflicts: totalConflicts,
          errors: totalErrors,
        };
      } catch (e) {
        logError("sync:now", e);
        return { ok: false, error: "Sync failed" };
      }
    }),
  );

  ipcMain.handle(
    "sync:browse-folder",
    requireAuth(async () => {
      const { dialog } = require("electron");
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      return { ok: true, path: result.filePaths[0] };
    }),
  );

  // Get per-file sync state for all folders (for expandable file tree)
  ipcMain.handle(
    "sync:file-states",
    requireAuthNoArgs(async () => {
      try {
        return { ok: true, states: engine.getAllFolderStates() };
      } catch (e) {
        logError("sync:file-states", e);
        return { ok: false, error: "Failed to get file states" };
      }
    }),
  );

  // Handle OS-level file/folder drops into the sync panel
  // Expects paths[] — each is an absolute local filesystem path from Electron's drag-and-drop
  ipcMain.handle(
    "sync:handle-drop",
    requireAuth(async (_e, { paths }: { paths: string[] }) => {
      logger.ipcLog("sync:handle-drop", "Handling dropped paths", { paths });
      try {
        const results: {
          path: string;
          ok: boolean;
          folderId?: string;
          error?: string;
        }[] = [];
        for (const p of paths) {
          try {
            const stat = fs.statSync(p);
            if (stat.isFile()) {
              const parentDir = path.dirname(p);
              const parentValidation = validateSyncPath(parentDir);
              if (!parentValidation.ok) {
                results.push({
                  path: p,
                  ok: false,
                  error: parentValidation.error,
                });
                continue;
              }
              const relFile = path
                .relative(parentValidation.realPath!, fs.realpathSync(p))
                .replaceAll("\\", "/");
              const folder = engine.addFolder(parentValidation.realPath!, "", [relFile]);
              results.push({ path: p, ok: true, folderId: folder.id });
              continue;
            }

            // Validate path before processing
            const validation = validateSyncPath(p);
            if (!validation.ok) {
              results.push({ path: p, ok: false, error: validation.error });
              continue;
            }

            const sanitizedName = sanitizeDriveFolderName(path.basename(validation.realPath!));
            const folder = engine.addFolder(validation.realPath!, sanitizedName);
            results.push({ path: p, ok: true, folderId: folder.id });
          } catch (e) {
            results.push({
              path: p,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        const added = results.filter((r) => r.ok).length;
        logger.success("sync:handle-drop", `Processed ${results.length} paths, ${added} added`);
        return { ok: true, results };
      } catch (e) {
        logError("sync:handle-drop", e);
        return { ok: false, error: "Failed to process dropped items" };
      }
    }),
  );

  // Start watching on init
  if (driveClient) {
    engine.startWatching();
  }

  return { updateDriveClient };
}
