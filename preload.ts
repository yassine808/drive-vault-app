import { contextBridge, ipcRenderer } from 'electron';

let sessionToken: string | null = null;

function setToken(t: string | null): void {
  sessionToken = t;
  ipcRenderer.send('preload:token', t ? 'set' : 'cleared');
}
function clearToken(): void {
  sessionToken = null;
  ipcRenderer.send('preload:token', 'cleared');
}

function bridgeLog(action: string, channel: string, ok: boolean, detail?: Record<string, unknown>): void {
  ipcRenderer.send('preload:log', { action, channel, ok, detail, ts: Date.now() });
}

contextBridge.exposeInMainWorld('api', {
  login: () => {
    bridgeLog('call', 'auth:login', true);
    return ipcRenderer.invoke('auth:login');
  },
  logout: () => {
    bridgeLog('call', 'auth:logout', true);
    const r = ipcRenderer.invoke('auth:logout', sessionToken);
    clearToken();
    return r;
  },
  lock: () => {
    bridgeLog('call', 'auth:lock', true);
    const r = ipcRenderer.invoke('auth:lock', sessionToken);
    clearToken();
    return r;
  },
  reauth: () => {
    bridgeLog('call', 'auth:reauth', true);
    return ipcRenderer.invoke('auth:reauth');
  },
  verify2fa: (code: string) => {
    bridgeLog('call', 'auth:verify2fa', true);
    return ipcRenderer.invoke('auth:verify2fa', sessionToken, { token: code });
  },

  save: (type: string, item: Record<string, unknown>) => {
    bridgeLog('call', 'vault:save', true, { type, dbId: item?._dbId as number });
    return ipcRenderer.invoke('vault:save', sessionToken, { type, item });
  },
  delete: (dbId: number) => {
    bridgeLog('call', 'vault:delete', true, { dbId });
    return ipcRenderer.invoke('vault:delete', sessionToken, { dbId });
  },
  sync: () => {
    bridgeLog('call', 'vault:sync', true);
    return ipcRenderer.invoke('vault:sync', sessionToken);
  },
  reorder: (type: string, items: unknown[]) => {
    bridgeLog('call', 'vault:reorder', true, { type, count: items?.length });
    return ipcRenderer.invoke('vault:reorder', sessionToken, { type, items });
  },

  trashLoad: () => {
    bridgeLog('call', 'trash:load', true);
    return ipcRenderer.invoke('trash:load', sessionToken);
  },
  trashRestore: (dbId: number) => {
    bridgeLog('call', 'trash:restore', true, { dbId });
    return ipcRenderer.invoke('trash:restore', sessionToken, { dbId });
  },
  trashPurge: (dbId: number) => {
    bridgeLog('call', 'trash:purge', true, { dbId });
    return ipcRenderer.invoke('trash:purge', sessionToken, { dbId });
  },

  logoFetch: (site: string) => {
    bridgeLog('call', 'logo:fetch', true, { site });
    return ipcRenderer.invoke('logo:fetch', sessionToken, { site });
  },

  jobsLoad: () => {
    bridgeLog('call', 'jobs:load', true);
    return ipcRenderer.invoke('jobs:load', sessionToken);
  },
  jobsSave: (job: Record<string, unknown>) => {
    bridgeLog('call', 'jobs:save', true, { jobId: job?.id as number, company: job?.company as string });
    return ipcRenderer.invoke('jobs:save', sessionToken, { job });
  },
  jobsDelete: (id: number) => {
    bridgeLog('call', 'jobs:delete', true, { jobId: id });
    return ipcRenderer.invoke('jobs:delete', sessionToken, { id });
  },
  jobsReorder: (jobs: unknown[]) => {
    bridgeLog('call', 'jobs:reorder', true, { count: jobs?.length });
    return ipcRenderer.invoke('jobs:reorder', sessionToken, { jobs });
  },
  jobsTrash: {
    load: () => {
      bridgeLog('call', 'jobs:trash:load', true);
      return ipcRenderer.invoke('jobs:trash:load', sessionToken);
    },
    restore: (id: number) => {
      bridgeLog('call', 'jobs:trash:restore', true, { jobId: id });
      return ipcRenderer.invoke('jobs:trash:restore', sessionToken, { id });
    },
    purge: (id: number) => {
      bridgeLog('call', 'jobs:trash:purge', true, { jobId: id });
      return ipcRenderer.invoke('jobs:trash:purge', sessionToken, { id });
    },
  },

  totpLoad: () => {
    bridgeLog('call', 'totp:load', true);
    return ipcRenderer.invoke('totp:load', sessionToken);
  },
  totpSave: (item: Record<string, unknown>) => {
    bridgeLog('call', 'totp:save', true, { itemId: item?.id as number, name: item?.name as string });
    return ipcRenderer.invoke('totp:save', sessionToken, { item });
  },
  totpDelete: (id: number) => {
    bridgeLog('call', 'totp:delete', true, { itemId: id });
    return ipcRenderer.invoke('totp:delete', sessionToken, { id });
  },

  twofa: {
    status: () => {
      bridgeLog('call', '2fa:status', true);
      return ipcRenderer.invoke('2fa:status', sessionToken);
    },
    setup: () => {
      bridgeLog('call', '2fa:setup', true);
      return ipcRenderer.invoke('2fa:setup', sessionToken);
    },
    enable: (token: string) => {
      bridgeLog('call', '2fa:enable', true);
      return ipcRenderer.invoke('2fa:enable', sessionToken, { token });
    },
    disable: (token: string) => {
      bridgeLog('call', '2fa:disable', true);
      return ipcRenderer.invoke('2fa:disable', sessionToken, { token });
    },
  },

  settings: {
    load: () => {
      bridgeLog('call', 'settings:load', true);
      return ipcRenderer.invoke('settings:load', sessionToken);
    },
    save: (s: Record<string, unknown>) => {
      bridgeLog('call', 'settings:save', true, s);
      return ipcRenderer.invoke('settings:save', sessionToken, { settings: s });
    },
  },

  monitor: {
    stats: () => {
      bridgeLog('call', 'monitor:stats', true);
      return ipcRenderer.invoke('monitor:stats', sessionToken);
    },
    readLog: () => {
      bridgeLog('call', 'log:read', true);
      return ipcRenderer.invoke('log:read', sessionToken);
    },
    clearLog: () => {
      bridgeLog('call', 'log:clear', true);
      return ipcRenderer.invoke('log:clear', sessionToken);
    },
  },

  admin: {
    users: () => {
      bridgeLog('call', 'admin:users', true);
      return ipcRenderer.invoke('admin:users', sessionToken);
    },
    stats: () => {
      bridgeLog('call', 'admin:stats', true);
      return ipcRenderer.invoke('admin:stats', sessionToken);
    },
  },

  onPlaySound: (cb: (type: string) => void) => ipcRenderer.on('play-sound', (_e, type) => cb(type)),
  onMinimize: (cb: () => void) => ipcRenderer.on('win:minimized', () => cb()),
  onMaximizedState: (cb: (maximized: boolean) => void) => ipcRenderer.on('win:maximized-state', (_e, maximized) => cb(maximized)),
  onTrayLock: (cb: () => void) => ipcRenderer.on('tray:lock', () => cb()),
  onTrayLogout: (cb: () => void) => ipcRenderer.on('tray:logout', () => cb()),

  minimize: () => { bridgeLog('call', 'win:minimize', true); return ipcRenderer.invoke('win:minimize', sessionToken); },
  maximize: () => { bridgeLog('call', 'win:maximize', true); return ipcRenderer.invoke('win:maximize', sessionToken); },
  close: () => { bridgeLog('call', 'win:close', true); return ipcRenderer.invoke('win:close', sessionToken); },
});

contextBridge.exposeInMainWorld('__vaultToken', {
  set: (t: string) => { setToken(t); },
  clear: () => { clearToken(); },
});
