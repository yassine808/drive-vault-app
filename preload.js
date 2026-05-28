'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Session token stored in preload, not accessible from renderer JS.
// Every sensitive IPC call automatically includes the token as the first argument.
let sessionToken = null;

function setToken(t) {
  sessionToken = t;
  // Notify main process about token changes for logging
  ipcRenderer.send('preload:token', t ? 'set' : 'cleared');
}
function clearToken() {
  sessionToken = null;
  ipcRenderer.send('preload:token', 'cleared');
}

// Helper to log bridge calls via a fire-and-forget IPC to main
function bridgeLog(action, channel, ok, detail) {
  ipcRenderer.send('preload:log', { action, channel, ok, detail, ts: Date.now() });
}

contextBridge.exposeInMainWorld('api', {
  // Auth — no token needed (token is returned on success)
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
  verify2fa: (code) => {
    bridgeLog('call', 'auth:verify2fa', true);
    return ipcRenderer.invoke('auth:verify2fa', sessionToken, { token: code });
  },

  // Sensitive — token prepended automatically
  save: (type, item) => {
    bridgeLog('call', 'vault:save', true, { type, dbId: item?._dbId });
    return ipcRenderer.invoke('vault:save', sessionToken, { type, item });
  },
  delete: (dbId) => {
    bridgeLog('call', 'vault:delete', true, { dbId });
    return ipcRenderer.invoke('vault:delete', sessionToken, { dbId });
  },
  sync: () => {
    bridgeLog('call', 'vault:sync', true);
    return ipcRenderer.invoke('vault:sync', sessionToken);
  },
  reorder: (type, items) => {
    bridgeLog('call', 'vault:reorder', true, { type, count: items?.length });
    return ipcRenderer.invoke('vault:reorder', sessionToken, { type, items });
  },

  trashLoad: () => {
    bridgeLog('call', 'trash:load', true);
    return ipcRenderer.invoke('trash:load', sessionToken);
  },
  trashRestore: (dbId) => {
    bridgeLog('call', 'trash:restore', true, { dbId });
    return ipcRenderer.invoke('trash:restore', sessionToken, { dbId });
  },
  trashPurge: (dbId) => {
    bridgeLog('call', 'trash:purge', true, { dbId });
    return ipcRenderer.invoke('trash:purge', sessionToken, { dbId });
  },

  logoFetch: (site) => {
    bridgeLog('call', 'logo:fetch', true, { site });
    return ipcRenderer.invoke('logo:fetch', sessionToken, { site });
  },

  jobsLoad: () => {
    bridgeLog('call', 'jobs:load', true);
    return ipcRenderer.invoke('jobs:load', sessionToken);
  },
  jobsSave: (job) => {
    bridgeLog('call', 'jobs:save', true, { jobId: job?.id, company: job?.company });
    return ipcRenderer.invoke('jobs:save', sessionToken, { job });
  },
  jobsDelete: (id) => {
    bridgeLog('call', 'jobs:delete', true, { jobId: id });
    return ipcRenderer.invoke('jobs:delete', sessionToken, { id });
  },
  jobsReorder: (jobs) => {
    bridgeLog('call', 'jobs:reorder', true, { count: jobs?.length });
    return ipcRenderer.invoke('jobs:reorder', sessionToken, { jobs });
  },
  jobsTrash: {
    load: () => {
      bridgeLog('call', 'jobs:trash:load', true);
      return ipcRenderer.invoke('jobs:trash:load', sessionToken);
    },
    restore: (id) => {
      bridgeLog('call', 'jobs:trash:restore', true, { jobId: id });
      return ipcRenderer.invoke('jobs:trash:restore', sessionToken, { id });
    },
    purge: (id) => {
      bridgeLog('call', 'jobs:trash:purge', true, { jobId: id });
      return ipcRenderer.invoke('jobs:trash:purge', sessionToken, { id });
    },
  },

  totpLoad: () => {
    bridgeLog('call', 'totp:load', true);
    return ipcRenderer.invoke('totp:load', sessionToken);
  },
  totpSave: (item) => {
    bridgeLog('call', 'totp:save', true, { itemId: item?.id, name: item?.name });
    return ipcRenderer.invoke('totp:save', sessionToken, { item });
  },
  totpDelete: (id) => {
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
    enable: (token) => {
      bridgeLog('call', '2fa:enable', true);
      return ipcRenderer.invoke('2fa:enable', sessionToken, { token });
    },
    disable: (token) => {
      bridgeLog('call', '2fa:disable', true);
      return ipcRenderer.invoke('2fa:disable', sessionToken, { token });
    },
  },

  settings: {
    load: () => {
      bridgeLog('call', 'settings:load', true);
      return ipcRenderer.invoke('settings:load', sessionToken);
    },
    save: (s) => {
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

  onPlaySound: (cb) => ipcRenderer.on('play-sound', (_e, type) => cb(type)),
  onMinimize: (cb) => ipcRenderer.on('win:minimized', () => cb()),
  onMaximizedState: (cb) => ipcRenderer.on('win:maximized-state', (_e, maximized) => cb(maximized)),
  onTrayLock: (cb) => ipcRenderer.on('tray:lock', () => cb()),
  onTrayLogout: (cb) => ipcRenderer.on('tray:logout', () => cb()),

  minimize: () => { bridgeLog('call', 'win:minimize', true); return ipcRenderer.invoke('win:minimize', sessionToken); },
  maximize: () => { bridgeLog('call', 'win:maximize', true); return ipcRenderer.invoke('win:maximize', sessionToken); },
  close: () => { bridgeLog('call', 'win:close', true); return ipcRenderer.invoke('win:close', sessionToken); },
});

// Expose token management so the renderer can store the token from login responses
contextBridge.exposeInMainWorld('__vaultToken', {
  set: (t) => { setToken(t); },
  clear: () => { clearToken(); },
});
