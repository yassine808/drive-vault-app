// Type declarations for the renderer process (app.ts)
// These extend the global Window interface for the preload bridge

import type {
  VaultItem, Job, TotpItem, Settings, UserProfile,
  VaultData, LogEntry, DriveStats, ConfirmOpts, TotpConfig,
  AuthResult, PinStatus, PinVerifyResult,
  SyncFolder, SyncConfig
} from './index';

export type { ConfirmOpts, TotpConfig, AuthResult, PreloadApi };

export interface PreloadApi {
  login(): Promise<AuthResult>;
  loginWithPin(verifyId: string): Promise<AuthResult>;
  logout(): Promise<void>;
  lock(): Promise<void>;
  reauth(): Promise<AuthResult>;
  verify2fa(code: string): Promise<AuthResult>;

  save(type: string, item: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }>;
  delete(id: string, type: string): Promise<{ ok: boolean; error?: string }>;
  vaultSync(): Promise<{ ok: boolean; vault?: VaultData; error?: string }>;
  reorder(type: string, items: unknown[]): Promise<{ ok: boolean }>;

  trashLoad(): Promise<{ ok: boolean; items: Array<VaultItem & { _type: string; _deletedAt: string }>; error?: string }>;
  trashRestore(id: string, type: string): Promise<{ ok: boolean }>;
  trashPurge(id: string, type: string): Promise<{ ok: boolean }>;

  logoFetch(site: string): Promise<{ ok: boolean; url?: string }>;

  jobsLoad(): Promise<{ ok: boolean; jobs: Job[]; error?: string }>;
  jobsSave(job: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }>;
  jobsDelete(id: string): Promise<{ ok: boolean; error?: string }>;
  jobsReorder(jobs: unknown[]): Promise<{ ok: boolean }>;
  jobsTrash: {
    load(): Promise<{ ok: boolean; items: Job[]; error?: string }>;
    restore(id: string): Promise<{ ok: boolean }>;
    purge(id: string): Promise<{ ok: boolean }>;
  };

  totpLoad(): Promise<{ ok: boolean; items: TotpItem[]; error?: string }>;
  totpSave(item: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }>;
  totpDelete(id: string): Promise<{ ok: boolean; error?: string }>;

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

  accounts: {
    list(): Promise<{ ok: boolean; accounts: Array<{ googleId: string; email: string; name: string; avatar: string | null; lastUsed: number }> }>;
    save(): Promise<{ ok: boolean; error?: string }>;
    remove(): Promise<{ ok: boolean; error?: string }>;
    touch(googleId: string): Promise<{ ok: boolean }>;
    removeById(googleId: string): Promise<{ ok: boolean; error?: string }>;
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

  sync: {
    foldersList(): Promise<{ ok: boolean; folders: SyncFolder[]; error?: string }>;
    foldersAdd(localPath: string, driveFolderName: string): Promise<{ ok: boolean; folder?: SyncFolder; error?: string }>;
    foldersRemove(folderId: string): Promise<{ ok: boolean; error?: string }>;
    foldersToggle(folderId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
    status(): Promise<{ ok: boolean; config: SyncConfig; error?: string }>;
    syncNow(): Promise<{ ok: boolean; uploaded?: number; downloaded?: number; conflicts?: number; errors?: number; error?: string }>;
    browseFolder(): Promise<{ ok: boolean; path?: string; canceled?: boolean }>;
    getFileStates(): Promise<{ ok: boolean; states: Record<string, { files: Record<string, { conflict: string; localHash: string | null; driveHash: string | null }> }>; error?: string }>;
    handleDrop(paths: string[]): Promise<{ ok: boolean; results: Array<{ ok: boolean }>; error?: string }>;
    onStatusUpdate(cb: (config: SyncConfig) => void): void;
  };

  getFilePath(file: File): string;

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
