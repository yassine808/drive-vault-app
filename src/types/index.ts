// Shared type definitions for Vault

export interface VaultUser {
  id: string;
  google_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at?: string;
  last_seen?: string;
}

export interface DriveStats {
  items: number;
  jobs: number;
  trash: number;
  logSize: number;
  cacheSizeBytes: number;
}

export interface Session {
  googleId: string;
  email: string;
  name: string;
  avatar: string | null;
  userId: string;
  encKey: string;
  pending2fa: boolean;
}

export interface VaultItem {
  _localId?: string;
  _sort?: number;
  id?: string;
  site?: string;
  username?: string;
  password?: string;
  notes?: string;
  type?: string;
  title?: string;
  body?: string;
  [key: string]: unknown;
}

export type TrashItem =
  | (VaultItem & { _type: string; _deletedAt: string })
  | (Job & { _type: string; _deletedAt: string });

export type ItemType = "password" | "note" | "job" | "totp";

export type JobStatus = "wait" | "accepted" | "rejected";

export interface Job {
  id?: string;
  company: string;
  role: string;
  email: string;
  applied_at: string;
  status: JobStatus;
  notes: string;
  sort_order?: number;
  deleted_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TotpItem {
  id?: string;
  name: string;
  issuer: string;
  secret: string;
  icon: string;
  sort_order?: number;
}

export interface Settings {
  lock_timeout: number;
  lock_action: "lock" | "exit";
  lock_countdown: boolean;
  lock_on_minimize: boolean;
  bg_speed: number;
  animations: boolean;
  accent: string;
  gen_length: number;
  gen_symbols: boolean;
  gen_numbers: boolean;
  gen_ambiguous: boolean;
  gen_copy: boolean;
  sounds: boolean;
  sound_login: boolean;
  sound_exit: boolean;
  sound_hover: boolean;
  sound_login_tone: string;
  sound_exit_tone: string;
  sound_hover_tone: string;
  toast_duration: number;
  pin_login_enabled: boolean;
  pin_allow_alpha: boolean;
}

export interface UserProfile {
  name: string;
  email: string;
  avatar: string | null;
  created_at?: string;
  last_seen?: string;
}

/** Return type for login/reauth/verify2fa IPC calls */
export interface AuthResult {
  ok: boolean;
  token?: string;
  user?: UserProfile;
  needs2fa?: boolean;
  error?: string;
  vault?: VaultData;
}

export interface VaultData {
  passwords: VaultItem[];
  notes: VaultItem[];
}

export interface LogEntry {
  level: string;
  ts: string;
  ctx: string;
  text: string;
}

export interface PinStatus {
  ok: boolean;
  enabled: boolean;
}

export interface PinVerifyResult {
  ok: boolean;
  error?: string;
  verifyId?: string;
  email?: string;
}

// ── Renderer-specific types ──

export interface ConfirmOpts {
  title: string;
  msg: string;
  icon?: string;
  okLabel?: string;
  okClass?: string;
  /** Used by confirm(); confirmDialog() uses Promise closure instead. */
  onOk?: () => void;
}

export interface TotpConfig {
  freqs: number[];
  type: string;
  dur: number;
  vol: number;
  gap: number;
}

export type AppAccent =
  | "violet"
  | "blue"
  | "teal"
  | "green"
  | "orange"
  | "rose"
  | "red"
  | "pink"
  | "yellow"
  | "amber"
  | "cyan"
  | "indigo"
  | "lime";

export type AppSoundTone = "chime" | "ding" | "soft" | "bright";
export type AppHoverTone = AppSoundTone | "click" | "tap" | "pop" | "none";

// ── Sync types ──

export type SyncFolderStatus = "idle" | "syncing" | "error" | "conflict";
export type SyncConflictType = "none" | "local_newer" | "drive_newer" | "both";

export interface SyncFolder {
  id: string;
  localPath: string;
  driveFolderName: string;
  includePaths?: string[];
  enabled: boolean;
  lastSyncAt: number | null;
  status: SyncFolderStatus;
  errorMessage?: string;
}

export interface SyncFileState {
  relativePath: string;
  localHash: string | null;
  localMtime: number | null;
  driveFileId: string | null;
  driveModifiedTime: string | null;
  driveHash: string | null;
  conflict: SyncConflictType;
}

export interface SyncFolderState {
  folderId: string;
  files: Record<string, SyncFileState>;
}

export interface SyncConfig {
  folders: SyncFolder[];
  globalState: "idle" | "syncing" | "error";
  lastFullSyncAt: number | null;
}