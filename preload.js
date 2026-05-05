'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  login:        ()            => ipcRenderer.invoke('auth:login'),
  logout:       ()            => ipcRenderer.invoke('auth:logout'),
  reauth:       ()            => ipcRenderer.invoke('auth:reauth'),
  verify2fa:    (token)       => ipcRenderer.invoke('auth:verify2fa', { token }),

  save:         (type, item)  => ipcRenderer.invoke('vault:save',    { type, item }),
  delete:       (dbId)        => ipcRenderer.invoke('vault:delete',  { dbId }),
  sync:         ()            => ipcRenderer.invoke('vault:sync'),
  reorder:      (type, items) => ipcRenderer.invoke('vault:reorder', { type, items }),

  trashLoad:    ()            => ipcRenderer.invoke('trash:load'),
  trashRestore: (dbId)        => ipcRenderer.invoke('trash:restore', { dbId }),
  trashPurge:   (dbId)        => ipcRenderer.invoke('trash:purge',   { dbId }),

  logoFetch:    (site)        => ipcRenderer.invoke('logo:fetch', { site }),

  jobsLoad:     ()            => ipcRenderer.invoke('jobs:load'),
  jobsSave:     (job)         => ipcRenderer.invoke('jobs:save',    { job }),
  jobsDelete:   (id)          => ipcRenderer.invoke('jobs:delete',  { id }),
  jobsReorder:  (jobs)        => ipcRenderer.invoke('jobs:reorder', { jobs }),
  jobsTrash: {
    load:    ()   => ipcRenderer.invoke('jobs:trash:load'),
    restore: (id) => ipcRenderer.invoke('jobs:trash:restore', { id }),
    purge:   (id) => ipcRenderer.invoke('jobs:trash:purge',   { id }),
  },

  totpLoad:     ()            => ipcRenderer.invoke('totp:load'),
  totpSave:     (item)        => ipcRenderer.invoke('totp:save',   { item }),
  totpDelete:   (id)          => ipcRenderer.invoke('totp:delete', { id }),

  twofa: {
    status:  ()      => ipcRenderer.invoke('2fa:status'),
    setup:   ()      => ipcRenderer.invoke('2fa:setup'),
    enable:  (token) => ipcRenderer.invoke('2fa:enable',  { token }),
    disable: ()      => ipcRenderer.invoke('2fa:disable'),
  },

  settings: {
    load: ()        => ipcRenderer.invoke('settings:load'),
    save: (s)       => ipcRenderer.invoke('settings:save', { settings: s }),
  },

  monitor: {
    stats:    () => ipcRenderer.invoke('monitor:stats'),
    readLog:  () => ipcRenderer.invoke('log:read'),
    clearLog: () => ipcRenderer.invoke('log:clear'),
  },

  onPlaySound: (cb) => ipcRenderer.on('play-sound', (_e, type) => cb(type)),

  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),
});
