// Type declarations for the renderer process (app.ts)
// These extend the global Window interface for the preload bridge

import type {
  VaultItem, Job, TotpItem, Settings, UserProfile,
  VaultData, LogEntry, DbStats, AdminStats, ConfirmOpts, TotpConfig,
  AuthResult, PinStatus, PinVerifyResult
} from './index';

export type { ConfirmOpts, TotpConfig, AuthResult, PreloadApi };

export interface PreloadApi {
  login(): Promise<AuthResult>;
  loginWithPin(googleId: string, email: string): Promise<AuthResult>;
  logout(): Promise<void>;
  lock(): Promise<void>;
  reauth(): Promise<AuthResult>;
  verify2fa(code: string): Promise<AuthResult>;

  save(type: string, item: Record<string, unknown>): Promise<{ ok: boolean; dbId?: number; error?: string }>;
  delete(dbId: number): Promise<{ ok: boolean; error?: string }>;
  sync(): Promise<{ ok: boolean; vault?: VaultData; error?: string }>;
  reorder(type: string, items: unknown[]): Promise<{ ok: boolean }>;

  trashLoad(): Promise<{ ok: boolean; items: Array<VaultItem & { _type: string; _deletedAt: string }>; error?: string }>;
  trashRestore(dbId: number): Promise<{ ok: boolean }>;
  trashPurge(dbId: number): Promise<{ ok: boolean }>;

  logoFetch(site: string): Promise<{ ok: boolean; url?: string }>;

  jobsLoad(): Promise<{ ok: boolean; jobs: Job[]; error?: string }>;
  jobsSave(job: Record<string, unknown>): Promise<{ ok: boolean; id?: number; error?: string }>;
  jobsDelete(id: number): Promise<{ ok: boolean; error?: string }>;
  jobsReorder(jobs: unknown[]): Promise<{ ok: boolean }>;
  jobsTrash: {
    load(): Promise<{ ok: boolean; items: Job[]; error?: string }>;
    restore(id: number): Promise<{ ok: boolean }>;
    purge(id: number): Promise<{ ok: boolean }>;
  };

  totpLoad(): Promise<{ ok: boolean; items: TotpItem[]; error?: string }>;
  totpSave(item: Record<string, unknown>): Promise<{ ok: boolean; id?: number; error?: string }>;
  totpDelete(id: number): Promise<{ ok: boolean; error?: string }>;

  twofa: {
    status(): Promise<{ enabled: boolean }>;
    setup(): Promise<{ ok: boolean; secret?: string; otpauth?: string; error?: string }>;
    enable(token: string): Promise<{ ok: boolean; error?: string }>;
    disable(token: string): Promise<{ ok: boolean; error?: string }>;
  };

  settings: {
    load(): Promise<{ ok: boolean; settings: Partial<Settings> }>;
    save(s: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  };

  monitor: {
    stats(): Promise<{ ok: boolean; stats: DbStats; error?: string }>;
    readLog(): Promise<{ ok: boolean; entries: LogEntry[] }>;
    clearLog(): Promise<{ ok: boolean }>;
  };

  admin: {
    users(): Promise<{ ok: boolean; users: UserProfile[]; error?: string }>;
    stats(): Promise<{ ok: boolean; stats: AdminStats; error?: string }>;
  };

  onPlaySound(cb: (type: string) => void): void;
  onMinimize(cb: () => void): void;
  onMaximizedState(cb: (maximized: boolean) => void): void;
  onTrayLock(cb: () => void): void;
  onTrayLogout(cb: () => void): void;

  pin: {
    setup(pin: string, allowAlpha: boolean): Promise<{ ok: boolean; error?: string }>;
    verify(pin: string): Promise<PinVerifyResult>;
    change(oldPin: string, newPin: string, allowAlpha: boolean): Promise<{ ok: boolean; error?: string }>;
    disable(): Promise<{ ok: boolean; error?: string }>;
    status(): Promise<PinStatus>;
  };

  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
}

declare global {
  interface Window {
    api: PreloadApi;
    __vaultToken: {
      set(t: string): void;
      clear(): void;
    };
    __soundsEnabled: boolean;
  }
  const api: PreloadApi;
}

export {};
