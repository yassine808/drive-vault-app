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
  _dbId?: number;
  _sort?: number;
  id?: number | string;
  site?: string;
  username?: string;
  password?: string;
  notes?: string;
  type?: string;
  title?: string;
  body?: string;
  [key: string]: unknown;
}

export type TrashItem = (VaultItem & { _type: string; _deletedAt: string }) | (Job & { _type: string; _deletedAt: string });

export type ItemType = 'password' | 'note';

export type JobStatus = 'wait' | 'accepted' | 'rejected';

export interface Job {
  id?: number;
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
  id?: number;
  name: string;
  issuer: string;
  secret: string;
  icon: string;
  sort_order?: number;
}

export interface Settings {
  lock_timeout: number;
  lock_action: 'lock' | 'exit';
  lock_countdown: boolean;
  lock_on_minimize: boolean;
  compact: boolean;
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
  isAdmin?: boolean;
  created_at?: string;
  last_seen?: string;
}

/** Return type for login/reauth/verify2fa IPC calls */
export interface AuthResult {
  ok: boolean;
  token?: string;
  user?: UserProfile & { isAdmin?: boolean };
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

export interface DbStats {
  items: number;
  jobs: number;
  trash: number;
  logSize: number;
  dbSizeBytes: number;
}

export interface AdminStats {
  totalUsers: number;
  totalItems: number;
  totalJobs: number;
  totalTotp: number;
}

export interface PinStatus {
  enabled: boolean;
  allowAlpha: boolean;
}

export interface PinVerifyResult {
  ok: boolean;
  error?: string;
  googleId?: string;
  email?: string;
}

// ── Renderer-specific types ──

export interface ConfirmOpts {
  title: string;
  msg: string;
  icon?: string;
  okLabel?: string;
  okClass?: string;
  onOk: () => void;
}

export interface TotpConfig {
  freqs: number[];
  type: string;
  dur: number;
  vol: number;
  gap: number;
}

export type AppAccent =
  | 'violet' | 'blue' | 'teal' | 'green' | 'orange'
  | 'rose' | 'red' | 'pink' | 'yellow' | 'amber'
  | 'cyan' | 'indigo' | 'lime';

export type AppSoundTone = 'chime' | 'ding' | 'soft' | 'bright';
export type AppHoverTone = AppSoundTone | 'click' | 'tap' | 'pop' | 'none';
