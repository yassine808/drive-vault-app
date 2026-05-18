'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Session token stored in preload, not accessible from renderer JS.
// Every sensitive IPC call automatically includes the token as the first argument.
let sessionToken = null;

function setToken(t) { sessionToken = t; }
function clearToken() { sessionToken = null; }

// Wraps an IPC call to prepend the session token
function withToken(...args) {
  return ipcRenderer.invoke(...args);
}

contextBridge.exposeInMainWorld('api', {
  // Auth — no token needed (token is returned on success)
  login:        ()            => ipcRenderer.invoke('auth:login'),
  logout:       ()            => { clearToken(); return ipcRenderer.invoke('auth:logout'); },
  reauth:       ()            => ipcRenderer.invoke('auth:reauth'),
  verify2fa:    (token)       => ipcRenderer.invoke('auth:verify2fa', { token }),
  onToken:      (cb) => { /* renderer calls this to store token from login response */ },

  // Sensitive — token prepended automatically
  save:         (type, item)  => ipcRenderer.invoke('vault:save',    sessionToken, { type, item }),
  delete:       (dbId)        => ipcRenderer.invoke('vault:delete',  sessionToken, { dbId }),
  sync:         ()            => ipcRenderer.invoke('vault:sync',    sessionToken),
  reorder:      (type, items) => ipcRenderer.invoke('vault:reorder', sessionToken, { type, items }),

  trashLoad:    ()            => ipcRenderer.invoke('trash:load',    sessionToken),
  trashRestore: (dbId)        => ipcRenderer.invoke('trash:restore', sessionToken, { dbId }),
  trashPurge:   (dbId)        => ipcRenderer.invoke('trash:purge',   sessionToken, { dbId }),

  logoFetch:    (site)        => ipcRenderer.invoke('logo:fetch',    sessionToken, { site }),

  jobsLoad:     ()            => ipcRenderer.invoke('jobs:load',   sessionToken),
  jobsSave:     (job)         => ipcRenderer.invoke('jobs:save',   sessionToken, { job }),
  jobsDelete:   (id)          => ipcRenderer.invoke('jobs:delete', sessionToken, { id }),
  jobsReorder:  (jobs)        => ipcRenderer.invoke('jobs:reorder', sessionToken, { jobs }),
  jobsTrash: {
    load:    ()   => ipcRenderer.invoke('jobs:trash:load',    sessionToken),
    restore: (id) => ipcRenderer.invoke('jobs:trash:restore', sessionToken, { id }),
    purge:   (id) => ipcRenderer.invoke('jobs:trash:purge',   sessionToken, { id }),
  },

  totpLoad:     ()            => ipcRenderer.invoke('totp:load',   sessionToken),
  totpSave:     (item)        => ipcRenderer.invoke('totp:save',   sessionToken, { item }),
  totpDelete:   (id)          => ipcRenderer.invoke('totp:delete', sessionToken, { id }),

  twofa: {
    status:  ()      => ipcRenderer.invoke('2fa:status',  sessionToken),
    setup:   ()      => ipcRenderer.invoke('2fa:setup',   sessionToken),
    enable:  (token) => ipcRenderer.invoke('2fa:enable',  sessionToken, { token }),
    disable: ()      => ipcRenderer.invoke('2fa:disable', sessionToken),
  },

  settings: {
    load: ()        => ipcRenderer.invoke('settings:load', sessionToken),
    save: (s)       => ipcRenderer.invoke('settings:save', sessionToken, { settings: s }),
  },

  monitor: {
    stats:    () => ipcRenderer.invoke('monitor:stats', sessionToken),
    readLog:  () => ipcRenderer.invoke('log:read',     sessionToken),
    clearLog: () => ipcRenderer.invoke('log:clear',    sessionToken),
  },

  onPlaySound: (cb) => ipcRenderer.on('play-sound', (_e, type) => cb(type)),

  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),
});

// Expose token management so the renderer can store the token from login responses
contextBridge.exposeInMainWorld('__vaultToken', {
  set: (t) => { sessionToken = t; },
  clear: () => { sessionToken = null; },
});
