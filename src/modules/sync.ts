import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import type { DriveClient } from './drive';
import type { Session, SyncFolder, SyncFileState, SyncFolderState, SyncConfig, SyncActivityEntry, SyncConflictType } from '../types';
import type Electron from 'electron';

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
const SYNC_CONFIG_FILE = 'sync_config.json';
const SYNC_STATE_FILE = 'sync_state.json';
const SYNC_DRIVE_FOLDER = ''; // sync folders go directly under Vault/ (no subfolder)
const MAX_ACTIVITY_LOG = 200;
const FILE_WATCH_DEBOUNCE_MS = 2000;

// Files to ignore during sync
const IGNORE_PATTERNS = [
  /^\./,                    // hidden files
  /\.tmp$/i,                // temp files
  /~$/,                     // backup files
  /\.\~$/,                  // lock files
  /^~\$/,                   // Office lock files
  /\.DS_Store$/i,           // macOS
  /^Thumbs\.db$/i,          // Windows
  /^desktop\.ini$/i,        // Windows
];

// ── Helpers ──

function getCacheDir(): string {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Vault', 'Cache');
}

function getConfigPath(): string {
  return path.join(getCacheDir(), SYNC_CONFIG_FILE);
}

function getStatePath(): string {
  return path.join(getCacheDir(), SYNC_STATE_FILE);
}

function shouldIgnore(fileName: string): boolean {
  return IGNORE_PATTERNS.some(p => p.test(fileName));
}

function sanitizeDriveFolderName(name: string): string {
  return name.replace(/[\/\\<>:|"?*\x00-\x1f]/g, '_').slice(0, 64);
}

async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function walkLocalFiles(localPath: string): Promise<Map<string, { hash: string; mtime: number }>> {
  const result = new Map<string, { hash: string; mtime: number }>();
  async function walk(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = path.relative(localPath, fullPath).replace(/\\/g, '/');
        try {
          const stat = await fs.promises.stat(fullPath);
          const hash = await computeFileHash(fullPath);
          result.set(relPath, { hash, mtime: stat.mtimeMs });
        } catch {
          // skip unreadable files
        }
      }
    }
  }
  await walk(localPath);
  return result;
}

// ── State persistence ──

function loadConfig(): SyncConfig {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      folders: parsed.folders || [],
      globalState: 'idle',
      lastFullSyncAt: parsed.lastFullSyncAt || null,
    };
  } catch {
    return { folders: [], globalState: 'idle', lastFullSyncAt: null };
  }
}

function saveConfig(config: SyncConfig): void {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify({
    version: 1,
    folders: config.folders,
    lastFullSyncAt: config.lastFullSyncAt,
  }, null, 2));
}

function loadState(): Record<string, SyncFolderState> {
  try {
    const raw = fs.readFileSync(getStatePath(), 'utf8');
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
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onChange: (folderId: string) => void;

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
        this.timers.set(folderId, setTimeout(() => {
          this.timers.delete(folderId);
          this.onChange(folderId);
        }, FILE_WATCH_DEBOUNCE_MS));
      });
      this.watchers.set(folderId, watcher);
    } catch {
      // fs.watch may fail on some paths — rely on manual sync
    }
  }

  unwatch(folderId: string): void {
    const w = this.watchers.get(folderId);
    if (w) { try { w.close(); } catch { /* noop */ } this.watchers.delete(folderId); }
    const t = this.timers.get(folderId);
    if (t) { clearTimeout(t); this.timers.delete(folderId); }
  }

  destroy(): void {
    for (const id of this.watchers.keys()) this.unwatch(id);
  }
}

// ── Sync engine ──

class SyncEngine {
  private drive: DriveClient | null = null;
  private syncFolderId: string | null = null;
  private activityLog: SyncActivityEntry[] = [];
  private fileWatcher: FileWatcher;
  private syncingFolders: Set<string> = new Set();

  constructor(driveClient: DriveClient | null) {
    this.drive = driveClient;
    this.fileWatcher = new FileWatcher((folderId) => {
      this.syncFolder(folderId).catch(() => {});
    });
  }

  setDriveClient(driveClient: DriveClient | null): void {
    this.drive = driveClient;
  }

  // Get the Vault folder ID on Drive (sync folders go directly under Vault/)
  private async getSyncFolderId(): Promise<string | null> {
    if (!this.drive || !(this.drive as any).drive) return null;
    if (this.syncFolderId) return this.syncFolderId;

    const vaultFolderId = (this.drive as any).vaultFolderId;
    if (!vaultFolderId) return null;

    // Sync folders are placed directly inside Vault/ — no intermediate subfolder needed.
    this.syncFolderId = vaultFolderId;
    return this.syncFolderId;
  }

  // Get or create a subfolder inside Vault/sync/ for a sync folder
  private async getDriveSubfolderId(driveFolderName: string): Promise<string | null> {
    const syncFolderId = await this.getSyncFolderId();
    if (!syncFolderId || !this.drive) return null;

    const drive = (this.drive as any).drive;
    const res = await drive.files.list({
      q: `name='${driveFolderName}' and mimeType='application/vnd.google-apps.folder' and '${syncFolderId}' in parents and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name)',
    });

    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id!;
    }

    const created = await drive.files.create({
      requestBody: {
        name: driveFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [syncFolderId],
      },
      fields: 'id',
    });
    return created.data.id!;
  }

  private addActivity(entry: SyncActivityEntry): void {
    this.activityLog.unshift(entry);
    if (this.activityLog.length > MAX_ACTIVITY_LOG) {
      this.activityLog = this.activityLog.slice(0, MAX_ACTIVITY_LOG);
    }
  }

  getActivityLog(): SyncActivityEntry[] {
    return [...this.activityLog];
  }

  // ── Two-way sync for one folder ──
  async syncFolder(folderId: string): Promise<{ uploaded: number; downloaded: number; conflicts: number; errors: number }> {
    const config = loadConfig();
    const folder = config.folders.find(f => f.id === folderId);
    if (!folder || !folder.enabled) return { uploaded: 0, downloaded: 0, conflicts: 0, errors: 0 };
    if (this.syncingFolders.has(folderId)) return { uploaded: 0, downloaded: 0, conflicts: 0, errors: 0 };

    this.syncingFolders.add(folderId);
    folder.status = 'syncing';
    saveConfig(config);

    let uploaded = 0, downloaded = 0, conflicts = 0, errors = 0;

    try {
      if (!this.drive || !(this.drive as any).drive) {
        throw new Error('Drive not initialized');
      }

      const driveSubfolderId = await this.getDriveSubfolderId(folder.driveFolderName);
      if (!driveSubfolderId) throw new Error('Could not access Drive sync folder');

      // 1. Scan local files
      const localFiles = await walkLocalFiles(folder.localPath);

      // 2. Scan Drive files
      const driveFiles = new Map<string, { fileId: string; modifiedTime: string; hash: string | null }>();
      const drive = (this.drive as any).drive;
      let pageToken: string | undefined;
      do {
        const res: any = await drive.files.list({
          q: `'${driveSubfolderId}' in parents and trashed=false`,
          spaces: 'drive',
          fields: 'nextPageToken, files(id, name, modifiedTime, appProperties)',
          pageSize: 1000,
          pageToken,
        });
        for (const f of (res.data.files || [])) {
          if (f.name && f.id) {
            driveFiles.set(f.name, {
              fileId: f.id,
              modifiedTime: f.modifiedTime || '',
              hash: f.appProperties?.contentHash || null,
            });
          }
        }
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);

      // 3. Load previous state
      const state = loadState();
      const folderState: SyncFolderState = state[folderId] || { folderId, files: {} };
      const allPaths = new Set([...localFiles.keys(), ...driveFiles.keys(), ...Object.keys(folderState.files)]);

      // 4. Three-way comparison
      const newState: SyncFolderState = { folderId, files: {} };

      for (const relPath of allPaths) {
        const local = localFiles.get(relPath) || null;
        const drive = driveFiles.get(relPath) || null;
        const prev = folderState.files[relPath] || null;

        newState.files[relPath] = {
          relativePath: relPath,
          localHash: local?.hash || null,
          localMtime: local?.mtime || null,
          driveFileId: drive?.fileId || null,
          driveModifiedTime: drive?.modifiedTime || null,
          driveHash: drive?.hash || null,
          conflict: 'none',
        };

        const localChanged = !prev || prev.localHash !== (local?.hash || null);
        const driveChanged = !prev || prev.driveHash !== (drive?.hash || null);
        const localExists = !!local;
        const driveExists = !!drive;

        if (localChanged && driveChanged && localExists && driveExists) {
          // Both changed → conflict
          newState.files[relPath].conflict = 'both';
          conflicts++;
          this.addActivity({
            ts: Date.now(),
            folderId,
            action: 'conflict',
            filePath: relPath,
            detail: 'Changed on both sides',
          });
          // Auto-resolve: keep both (download Drive version with suffix)
          try {
            const conflictName = this.addConflictSuffix(relPath);
            await this.downloadFile(drive!.fileId, path.join(folder.localPath, conflictName));
            newState.files[conflictName] = {
              relativePath: conflictName,
              localHash: drive!.hash,
              localMtime: Date.now(),
              driveFileId: drive!.fileId,
              driveModifiedTime: drive!.modifiedTime,
              driveHash: drive!.hash,
              conflict: 'none',
            };
            downloaded++;
            this.addActivity({
              ts: Date.now(),
              folderId,
              action: 'download',
              filePath: conflictName,
              detail: 'Conflict: kept both versions',
            });
          } catch (e) {
            errors++;
            this.addActivity({
              ts: Date.now(),
              folderId,
              action: 'error',
              filePath: relPath,
              detail: `Conflict resolution failed: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
          // Upload local version as-is
          try {
            const fileHash = local!.hash;
            await this.uploadFile(path.join(folder.localPath, relPath), relPath, driveSubfolderId, fileHash);
            uploaded++;
            this.addActivity({
              ts: Date.now(),
              folderId,
              action: 'upload',
              filePath: relPath,
              detail: 'Conflict: uploaded local version',
            });
          } catch (e) {
            errors++;
          }
        } else if (localChanged && localExists) {
          // Upload new/changed local file
          try {
            const fileHash = local!.hash;
            const existingDrive = driveFiles.get(relPath);
            if (existingDrive) {
              await this.updateFile(existingDrive.fileId, path.join(folder.localPath, relPath), fileHash);
            } else {
              await this.uploadFile(path.join(folder.localPath, relPath), relPath, driveSubfolderId, fileHash);
            }
            uploaded++;
            this.addActivity({ ts: Date.now(), folderId, action: 'upload', filePath: relPath });
          } catch (e) {
            errors++;
            this.addActivity({
              ts: Date.now(), folderId, action: 'error', filePath: relPath,
              detail: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        } else if (driveChanged && driveExists) {
          // Download new/changed Drive file
          try {
            await this.downloadFile(drive!.fileId, path.join(folder.localPath, relPath));
            downloaded++;
            this.addActivity({ ts: Date.now(), folderId, action: 'download', filePath: relPath });
          } catch (e) {
            errors++;
            this.addActivity({
              ts: Date.now(), folderId, action: 'error', filePath: relPath,
              detail: `Download failed: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        } else if (!localExists && driveExists && prev) {
          // Deleted locally → delete on Drive
          try {
            await (this.drive as any).drive.files.delete({ fileId: drive!.fileId });
            this.addActivity({ ts: Date.now(), folderId, action: 'delete_drive', filePath: relPath });
          } catch (e) {
            errors++;
          }
          continue; // don't add to newState
        } else if (!driveExists && localExists && prev) {
          // Deleted on Drive → delete locally
          try {
            await fs.promises.unlink(path.join(folder.localPath, relPath));
            this.addActivity({ ts: Date.now(), folderId, action: 'delete_local', filePath: relPath });
          } catch (e) {
            errors++;
          }
          continue; // don't add to newState
        } else if (!localExists && !driveExists) {
          // Deleted on both sides
          continue;
        }
        // If unchanged, keep in newState as-is
      }

      // Clean up empty directories after deletions
      this.cleanupEmptyDirs(folder.localPath);

      // Save state
      state[folderId] = newState;
      saveState(state);

      // Update folder status
      const hasConflicts = Object.values(newState.files).some(f => f.conflict !== 'none');
      folder.status = errors > 0 ? 'error' : (hasConflicts ? 'conflict' : 'idle');
      folder.lastSyncAt = Date.now();
      if (errors > 0) folder.errorMessage = `${errors} error(s)`;
      saveConfig(config);

    } catch (e) {
      errors++;
      folder.status = 'error';
      folder.errorMessage = e instanceof Error ? e.message : String(e);
      folder.lastSyncAt = Date.now();
      saveConfig(config);
      this.addActivity({
        ts: Date.now(), folderId, action: 'error', filePath: '/',
        detail: e instanceof Error ? e.message : String(e),
      });
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

  private async uploadFile(localPath: string, driveFileName: string, parentFolderId: string, contentHash: string): Promise<void> {
    const drive = (this.drive as any).drive;
    const content = fs.createReadStream(localPath);
    await drive.files.create({
      requestBody: {
        name: driveFileName,
        parents: [parentFolderId],
        mimeType: 'application/octet-stream',
        appProperties: { contentHash },
      },
      media: { mimeType: 'application/octet-stream', body: content },
      fields: 'id',
    });
  }

  private async updateFile(fileId: string, localPath: string, contentHash: string): Promise<void> {
    const drive = (this.drive as any).drive;
    const content = fs.createReadStream(localPath);
    await drive.files.update({
      fileId,
      media: { mimeType: 'application/octet-stream', body: content },
      fields: 'id',
    });
    // Update appProperties with new hash via a separate patch call
    await drive.files.update({
      fileId,
      requestBody: { appProperties: { contentHash } },
      fields: 'id',
    });
  }

  private async downloadFile(fileId: string, localPath: string): Promise<void> {
    const drive = (this.drive as any).drive;
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localPath, Buffer.from(res.data as ArrayBuffer));
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
      // ignore
    }
  }

  // ── Folder management ──

  addFolder(localPath: string, driveFolderName: string): SyncFolder {
    const config = loadConfig();
    const folder: SyncFolder = {
      id: crypto.randomUUID(),
      localPath: path.resolve(localPath),
      driveFolderName: sanitizeDriveFolderName(driveFolderName),
      enabled: true,
      lastSyncAt: null,
      status: 'idle',
    };
    config.folders.push(folder);
    saveConfig(config);
    this.fileWatcher.watch(folder.id, folder.localPath);
    return folder;
  }

  removeFolder(folderId: string): void {
    const config = loadConfig();
    const folder = config.folders.find(f => f.id === folderId);
    if (folder) {
      this.fileWatcher.unwatch(folderId);
      // Remove state
      const state = loadState();
      delete state[folderId];
      saveState(state);
    }
    config.folders = config.folders.filter(f => f.id !== folderId);
    saveConfig(config);
  }

  toggleFolder(folderId: string, enabled: boolean): void {
    const config = loadConfig();
    const folder = config.folders.find(f => f.id === folderId);
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
  (global as any).__syncEngine = engine;

  ipcMain.handle('sync:folders:list', requireAuthNoArgs(async () => {
    try {
      return { ok: true, folders: engine.getConfig().folders };
    } catch (e) {
      logError('sync:folders:list', e);
      return { ok: false, error: 'Failed to list sync folders' };
    }
  }));

  ipcMain.handle('sync:folders:add', requireAuth(async (_e, { localPath, driveFolderName }: { localPath: string; driveFolderName: string }) => {
    logger.ipcLog('sync:folders:add', 'Adding sync folder', { localPath, driveFolderName });
    try {
      // Validate local path
      if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
        return { ok: false, error: 'Path does not exist or is not a directory' };
      }
      // Validate not a system directory
      const resolved = path.resolve(localPath);
      const forbidden = ['/Windows', '/Program Files', '/System', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
      if (forbidden.some(f => resolved.startsWith(f))) {
        return { ok: false, error: 'Cannot sync system directories' };
      }
      const folder = engine.addFolder(localPath, driveFolderName || path.basename(localPath));
      logger.success('sync:folders:add', 'Sync folder added', { id: folder.id, path: localPath });
      return { ok: true, folder };
    } catch (e) {
      logError('sync:folders:add', e);
      return { ok: false, error: 'Failed to add sync folder' };
    }
  }));

  ipcMain.handle('sync:folders:remove', requireAuth(async (_e, { folderId }: { folderId: string }) => {
    logger.ipcLog('sync:folders:remove', 'Removing sync folder', { folderId });
    try {
      engine.removeFolder(folderId);
      logger.success('sync:folders:remove', 'Sync folder removed');
      return { ok: true };
    } catch (e) {
      logError('sync:folders:remove', e);
      return { ok: false, error: 'Failed to remove sync folder' };
    }
  }));

  ipcMain.handle('sync:folders:toggle', requireAuth(async (_e, { folderId, enabled }: { folderId: string; enabled: boolean }) => {
    logger.ipcLog('sync:folders:toggle', 'Toggling sync folder', { folderId, enabled });
    try {
      engine.toggleFolder(folderId, enabled);
      logger.success('sync:folders:toggle', 'Sync folder toggled');
      return { ok: true };
    } catch (e) {
      logError('sync:folders:toggle', e);
      return { ok: false, error: 'Failed to toggle sync folder' };
    }
  }));

  ipcMain.handle('sync:status', requireAuthNoArgs(async () => {
    try {
      return { ok: true, config: engine.getConfig() };
    } catch (e) {
      logError('sync:status', e);
      return { ok: false, error: 'Failed to get sync status' };
    }
  }));

  ipcMain.handle('sync:now', requireAuth(async () => {
    logger.ipcLog('sync:now', 'Manual sync triggered');
    try {
      const config = engine.getConfig();
      let totalUploaded = 0, totalDownloaded = 0, totalConflicts = 0, totalErrors = 0;
      for (const folder of config.folders) {
        if (!folder.enabled) continue;
        const result = await engine.syncFolder(folder.id);
        totalUploaded += result.uploaded;
        totalDownloaded += result.downloaded;
        totalConflicts += result.conflicts;
        totalErrors += result.errors;
      }
      logger.success('sync:now', 'Sync complete', { uploaded: totalUploaded, downloaded: totalDownloaded, conflicts: totalConflicts, errors: totalErrors });
      return { ok: true, uploaded: totalUploaded, downloaded: totalDownloaded, conflicts: totalConflicts, errors: totalErrors };
    } catch (e) {
      logError('sync:now', e);
      return { ok: false, error: 'Sync failed' };
    }
  }));

  ipcMain.handle('sync:log', requireAuthNoArgs(async () => {
    try {
      return { ok: true, entries: engine.getActivityLog() };
    } catch (e) {
      logError('sync:log', e);
      return { ok: false, error: 'Failed to get activity log' };
    }
  }));

  ipcMain.handle('sync:browse-folder', requireAuth(async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return { ok: true, path: result.filePaths[0] };
  }));

  // Get per-file sync state for all folders (for expandable file tree)
  ipcMain.handle('sync:file-states', requireAuthNoArgs(async () => {
    try {
      return { ok: true, states: engine.getAllFolderStates() };
    } catch (e) {
      logError('sync:file-states', e);
      return { ok: false, error: 'Failed to get file states' };
    }
  }));

  // Handle OS-level file/folder drops into the sync panel
  // Expects paths[] — each is an absolute local filesystem path from Electron's drag-and-drop
  ipcMain.handle('sync:handle-drop', requireAuth(async (_e, { paths }: { paths: string[] }) => {
    logger.ipcLog('sync:handle-drop', 'Handling dropped paths', { paths });
    try {
      const results: { path: string; ok: boolean; folderId?: string; error?: string }[] = [];
      for (const p of paths) {
        try {
          const stat = fs.statSync(p);
          if (stat.isDirectory()) {
            const folder = engine.addFolder(p, path.basename(p));
            results.push({ path: p, ok: true, folderId: folder.id });
          } else if (stat.isFile()) {
            // For files: create/sync the parent directory
            const parentDir = path.dirname(p);
            const folder = engine.addFolder(parentDir, path.basename(parentDir));
            results.push({ path: p, ok: true, folderId: folder.id });
          } else {
            results.push({ path: p, ok: false, error: 'Not a file or directory' });
          }
        } catch (e) {
          results.push({ path: p, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const added = results.filter(r => r.ok).length;
      logger.success('sync:handle-drop', `Processed ${results.length} paths, ${added} added`);
      return { ok: true, results };
    } catch (e) {
      logError('sync:handle-drop', e);
      return { ok: false, error: 'Failed to process dropped items' };
    }
  }));

  // Start watching on init
  if (driveClient) {
    engine.startWatching();
  }
}
