"use strict";

// .claude/worktrees/ts-migration/preload.ts
var import_electron = require("electron");
var sessionToken = null;
function setToken(t) {
  sessionToken = t;
  import_electron.ipcRenderer.send("preload:token", t ? "set" : "cleared");
}
function clearToken() {
  sessionToken = null;
  import_electron.ipcRenderer.send("preload:token", "cleared");
}
function bridgeLog(action, channel, ok, detail) {
  import_electron.ipcRenderer.send("preload:log", { action, channel, ok, detail, ts: Date.now() });
}
import_electron.contextBridge.exposeInMainWorld("api", {
  login: () => {
    bridgeLog("call", "auth:login", true);
    return import_electron.ipcRenderer.invoke("auth:login");
  },
  logout: () => {
    bridgeLog("call", "auth:logout", true);
    const r = import_electron.ipcRenderer.invoke("auth:logout", sessionToken);
    clearToken();
    return r;
  },
  lock: () => {
    bridgeLog("call", "auth:lock", true);
    const r = import_electron.ipcRenderer.invoke("auth:lock", sessionToken);
    clearToken();
    return r;
  },
  reauth: () => {
    bridgeLog("call", "auth:reauth", true);
    return import_electron.ipcRenderer.invoke("auth:reauth");
  },
  verify2fa: (code) => {
    bridgeLog("call", "auth:verify2fa", true);
    return import_electron.ipcRenderer.invoke("auth:verify2fa", sessionToken, { token: code });
  },
  save: (type, item) => {
    bridgeLog("call", "vault:save", true, { type, dbId: item?._dbId });
    return import_electron.ipcRenderer.invoke("vault:save", sessionToken, { type, item });
  },
  delete: (dbId) => {
    bridgeLog("call", "vault:delete", true, { dbId });
    return import_electron.ipcRenderer.invoke("vault:delete", sessionToken, { dbId });
  },
  sync: () => {
    bridgeLog("call", "vault:sync", true);
    return import_electron.ipcRenderer.invoke("vault:sync", sessionToken);
  },
  reorder: (type, items) => {
    bridgeLog("call", "vault:reorder", true, { type, count: items?.length });
    return import_electron.ipcRenderer.invoke("vault:reorder", sessionToken, { type, items });
  },
  trashLoad: () => {
    bridgeLog("call", "trash:load", true);
    return import_electron.ipcRenderer.invoke("trash:load", sessionToken);
  },
  trashRestore: (dbId) => {
    bridgeLog("call", "trash:restore", true, { dbId });
    return import_electron.ipcRenderer.invoke("trash:restore", sessionToken, { dbId });
  },
  trashPurge: (dbId) => {
    bridgeLog("call", "trash:purge", true, { dbId });
    return import_electron.ipcRenderer.invoke("trash:purge", sessionToken, { dbId });
  },
  logoFetch: (site) => {
    bridgeLog("call", "logo:fetch", true, { site });
    return import_electron.ipcRenderer.invoke("logo:fetch", sessionToken, { site });
  },
  jobsLoad: () => {
    bridgeLog("call", "jobs:load", true);
    return import_electron.ipcRenderer.invoke("jobs:load", sessionToken);
  },
  jobsSave: (job) => {
    bridgeLog("call", "jobs:save", true, { jobId: job?.id, company: job?.company });
    return import_electron.ipcRenderer.invoke("jobs:save", sessionToken, { job });
  },
  jobsDelete: (id) => {
    bridgeLog("call", "jobs:delete", true, { jobId: id });
    return import_electron.ipcRenderer.invoke("jobs:delete", sessionToken, { id });
  },
  jobsReorder: (jobs) => {
    bridgeLog("call", "jobs:reorder", true, { count: jobs?.length });
    return import_electron.ipcRenderer.invoke("jobs:reorder", sessionToken, { jobs });
  },
  jobsTrash: {
    load: () => {
      bridgeLog("call", "jobs:trash:load", true);
      return import_electron.ipcRenderer.invoke("jobs:trash:load", sessionToken);
    },
    restore: (id) => {
      bridgeLog("call", "jobs:trash:restore", true, { jobId: id });
      return import_electron.ipcRenderer.invoke("jobs:trash:restore", sessionToken, { id });
    },
    purge: (id) => {
      bridgeLog("call", "jobs:trash:purge", true, { jobId: id });
      return import_electron.ipcRenderer.invoke("jobs:trash:purge", sessionToken, { id });
    }
  },
  totpLoad: () => {
    bridgeLog("call", "totp:load", true);
    return import_electron.ipcRenderer.invoke("totp:load", sessionToken);
  },
  totpSave: (item) => {
    bridgeLog("call", "totp:save", true, { itemId: item?.id, name: item?.name });
    return import_electron.ipcRenderer.invoke("totp:save", sessionToken, { item });
  },
  totpDelete: (id) => {
    bridgeLog("call", "totp:delete", true, { itemId: id });
    return import_electron.ipcRenderer.invoke("totp:delete", sessionToken, { id });
  },
  twofa: {
    status: () => {
      bridgeLog("call", "2fa:status", true);
      return import_electron.ipcRenderer.invoke("2fa:status", sessionToken);
    },
    setup: () => {
      bridgeLog("call", "2fa:setup", true);
      return import_electron.ipcRenderer.invoke("2fa:setup", sessionToken);
    },
    enable: (token) => {
      bridgeLog("call", "2fa:enable", true);
      return import_electron.ipcRenderer.invoke("2fa:enable", sessionToken, { token });
    },
    disable: (token) => {
      bridgeLog("call", "2fa:disable", true);
      return import_electron.ipcRenderer.invoke("2fa:disable", sessionToken, { token });
    }
  },
  settings: {
    load: () => {
      bridgeLog("call", "settings:load", true);
      return import_electron.ipcRenderer.invoke("settings:load", sessionToken);
    },
    save: (s) => {
      bridgeLog("call", "settings:save", true, s);
      return import_electron.ipcRenderer.invoke("settings:save", sessionToken, { settings: s });
    }
  },
  monitor: {
    stats: () => {
      bridgeLog("call", "monitor:stats", true);
      return import_electron.ipcRenderer.invoke("monitor:stats", sessionToken);
    },
    readLog: () => {
      bridgeLog("call", "log:read", true);
      return import_electron.ipcRenderer.invoke("log:read", sessionToken);
    },
    clearLog: () => {
      bridgeLog("call", "log:clear", true);
      return import_electron.ipcRenderer.invoke("log:clear", sessionToken);
    }
  },
  admin: {
    users: () => {
      bridgeLog("call", "admin:users", true);
      return import_electron.ipcRenderer.invoke("admin:users", sessionToken);
    },
    stats: () => {
      bridgeLog("call", "admin:stats", true);
      return import_electron.ipcRenderer.invoke("admin:stats", sessionToken);
    }
  },
  onPlaySound: (cb) => import_electron.ipcRenderer.on("play-sound", (_e, type) => cb(type)),
  onMinimize: (cb) => import_electron.ipcRenderer.on("win:minimized", () => cb()),
  onMaximizedState: (cb) => import_electron.ipcRenderer.on("win:maximized-state", (_e, maximized) => cb(maximized)),
  onTrayLock: (cb) => import_electron.ipcRenderer.on("tray:lock", () => cb()),
  onTrayLogout: (cb) => import_electron.ipcRenderer.on("tray:logout", () => cb()),
  minimize: () => {
    bridgeLog("call", "win:minimize", true);
    return import_electron.ipcRenderer.invoke("win:minimize", sessionToken);
  },
  maximize: () => {
    bridgeLog("call", "win:maximize", true);
    return import_electron.ipcRenderer.invoke("win:maximize", sessionToken);
  },
  close: () => {
    bridgeLog("call", "win:close", true);
    return import_electron.ipcRenderer.invoke("win:close", sessionToken);
  }
});
import_electron.contextBridge.exposeInMainWorld("__vaultToken", {
  set: (t) => {
    setToken(t);
  },
  clear: () => {
    clearToken();
  }
});
//# sourceMappingURL=preload.js.map
