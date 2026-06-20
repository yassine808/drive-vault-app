import path from 'path';
import fs from 'fs';

/**
 * Local file-based cache for all vault data.
 * Stores encrypted items as JSON on disk in the user data directory.
 * Provides offline support and fast local reads.
 */

let _userDataPath: string = '';

export function setUserDataPath(p: string): void {
  _userDataPath = p;
}

function getCacheDir(): string {
  const userData = _userDataPath
    || process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : path.join(process.env.HOME || '', '.config'));
  const dir = path.join(userData, 'Vault', 'Cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  return dir;
}

function getCacheFilePath(): string {
  return path.join(getCacheDir(), 'vault_cache.json');
}

export interface CacheData {
  version: number;
  googleId: string;
  passwords: CacheItem[];
  notes: CacheItem[];
  jobs: CacheItem[];
  totp: CacheItem[];
  settings: Record<string, unknown> | null;
  twofa: CacheTwofa | null;
  logos: CacheLogo[];
  /** Items pending sync to Google Drive */
  dirtyQueue: DirtyItem[];
  /** ETags keyed by Drive file ID, used for conflict resolution */
  etags: Record<string, string>;
  lastSyncedAt: number;
}

export interface CacheItem {
  id: string;           // local UUID
  sortOrder: number;
  encryptedData: string; // AES-256-CBC + HMAC encrypted JSON
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CacheTwofa {
  secret: string;
  enabled: boolean;
}

export interface CacheLogo {
  domain: string;
  url: string;
  cachedAt: string;
}

export interface DirtyItem {
  id: string;
  type: 'password' | 'note' | 'job' | 'totp' | 'settings' | 'logo';
  action: 'create' | 'update' | 'delete';
  driveFileId?: string;
  retryCount: number;
  lastAttempt: number;
}

function defaultCache(googleId: string): CacheData {
  return {
    version: 1,
    googleId,
    passwords: [],
    notes: [],
    jobs: [],
    totp: [],
    settings: null,
    twofa: null,
    logos: [],
    dirtyQueue: [],
    etags: {},
    lastSyncedAt: 0,
  };
}

export function loadCache(googleId: string): CacheData {
  try {
    const file = getCacheFilePath();
    if (!fs.existsSync(file)) return defaultCache(googleId);
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as CacheData;
    if (data.googleId !== googleId) return defaultCache(googleId);
    // Ensure all fields exist (forward compat)
    const def = defaultCache(googleId);
    return { ...def, ...data };
  } catch {
    return defaultCache(googleId);
  }
}

export function saveCache(cache: CacheData): void {
  try {
    fs.writeFileSync(getCacheFilePath(), JSON.stringify(cache, null, 2));
  } catch { /* noop */ }
}

export function getCacheDir_(): string {
  return getCacheDir();
}
