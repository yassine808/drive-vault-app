'use strict';

const fs = require('fs');
const path = require('path');

// ─── LOG DIRECTORY ───────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, '..', 'Logs');

// Map each level name to its own file
const LEVEL_FILES = {
  DEBUG:   'debug.log',
  INFO:    'info.log',
  SUCCESS: 'success.log',
  WARN:    'warn.log',
  ERROR:   'error.log',
  AUTH:    'auth.log',
  IPC:     'ipc.log',
  DB:      'db.log',
};

// ─── LEVELS ───────────────────────────────────────────────────────────────────
const LEVELS = { DEBUG: 0, INFO: 1, SUCCESS: 2, WARN: 3, ERROR: 4, AUTH: 5, IPC: 6, DB: 7 };
const LEVEL_NAMES = ['DEBUG', 'INFO', 'SUCCESS', 'WARN', 'ERROR', 'AUTH', 'IPC', 'DB'];

// ─── STATE ────────────────────────────────────────────────────────────────────
let initialized = false;

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  if (initialized) return;
  initialized = true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    console.error('[logger] Failed to create Logs directory:', e.message);
  }
}

// ─── TIMESTAMP ────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString(); }

// ─── GET FILE PATH FOR A LEVEL ────────────────────────────────────────────────
function fileForLevel(levelName) {
  const name = String(levelName).toUpperCase();
  const filename = LEVEL_FILES[name] || 'unknown.log';
  return path.join(LOG_DIR, filename);
}

// ─── CORE WRITE ───────────────────────────────────────────────────────────────
function write(level, ctx, msg, data) {
  init();
  const levelName = LEVEL_NAMES[level] || 'UNKNOWN';
  let line = `[${ts()}] [${ctx}] ${msg}`;
  if (data !== undefined) {
    try {
      const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 0) : String(data);
      line += ` | data: ${dataStr}`;
    } catch { line += ' | data: [unserializable]'; }
  }
  line += '\n';

  // Write to the level-specific file
  try { fs.appendFileSync(fileForLevel(levelName), line); } catch {}

  // Also write to a combined catch-all file
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'all.log'), `[${levelName}] ${line}`);
  } catch {}

  // Mirror to console
  if (level >= LEVELS.ERROR) console.error(line.trim());
  else if (level >= LEVELS.WARN) console.warn(line.trim());
  else console.log(line.trim());
}

// ─── LEGACY ERROR WRITER (keeps old vault-errors.log working) ─────────────────
function writeError(ctx, err) {
  init();
  const extra = err?.response?.data ? ` | response: ${JSON.stringify(err.response.data)}` : '';
  const line = `[${ts()}] [${ctx}] ${err?.message || err}${extra}\ncode: ${err?.code || 'none'} | status: ${err?.response?.status || 'none'}\n${err?.stack || ''}\n---\n`;
  try { fs.appendFileSync(fileForLevel('ERROR'), line); } catch {}
  try { fs.appendFileSync(path.join(LOG_DIR, 'all.log'), `[ERROR] ${line}`); } catch {}
  console.error(line);
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────
function debug(ctx, msg, data)    { write(LEVELS.DEBUG, ctx, msg, data); }
function info(ctx, msg, data)     { write(LEVELS.INFO, ctx, msg, data); }
function success(ctx, msg, data)  { write(LEVELS.SUCCESS, ctx, msg, data); }
function warn(ctx, msg, data)     { write(LEVELS.WARN, ctx, msg, data); }
function error(ctx, msg, data)    { write(LEVELS.ERROR, ctx, msg, data); }
function auth(ctx, msg, data)     { write(LEVELS.AUTH, ctx, msg, data); }
function ipc(ctx, msg, data)      { write(LEVELS.IPC, ctx, msg, data); }
function db(ctx, msg, data)       { write(LEVELS.DB, ctx, msg, data); }

// ─── LOG ROTATION ─────────────────────────────────────────────────────────────
function rotateIfNeeded(maxSize = 5 * 1024 * 1024) {
  init();
  try {
    for (const filename of Object.values(LEVEL_FILES)) {
      const filePath = path.join(LOG_DIR, filename);
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > maxSize) {
          const rotated = filePath + '.' + Date.now() + '.bak';
          fs.renameSync(filePath, rotated);
          console.log(`[logger] Rotated ${filename} → ${path.basename(rotated)}`);
        }
      } catch {}
    }
    // Also rotate all.log
    const allPath = path.join(LOG_DIR, 'all.log');
    try {
      const stat = fs.statSync(allPath);
      if (stat.size > maxSize) {
        const rotated = allPath + '.' + Date.now() + '.bak';
        fs.renameSync(allPath, rotated);
        console.log(`[logger] Rotated all.log → ${path.basename(rotated)}`);
      }
    } catch {}
  } catch {}
}

// ─── READ / CLEAR ─────────────────────────────────────────────────────────────
function readLog(levelName, maxChars = 10000) {
  try {
    const filePath = fileForLevel(levelName);
    if (!fs.existsSync(filePath)) return `(no ${levelName.toLowerCase()}.log file)`;
    const content = fs.readFileSync(filePath, 'utf8');
    return content.slice(-maxChars);
  } catch { return `(could not read ${levelName.toLowerCase()}.log)`; }
}

function readAllLog(maxChars = 10000) {
  try {
    const allPath = path.join(LOG_DIR, 'all.log');
    if (!fs.existsSync(allPath)) return '(no all.log file)';
    const content = fs.readFileSync(allPath, 'utf8');
    return content.slice(-maxChars);
  } catch { return '(could not read all.log)'; }
}

function clearLog(levelName) {
  try {
    fs.writeFileSync(fileForLevel(levelName), '');
    return true;
  } catch { return false; }
}

function clearAllLogs() {
  init();
  try {
    for (const filename of Object.values(LEVEL_FILES)) {
      fs.writeFileSync(path.join(LOG_DIR, filename), '');
    }
    fs.writeFileSync(path.join(LOG_DIR, 'all.log'), '');
    return true;
  } catch { return false; }
}

function getLogDir() { return LOG_DIR; }
function getLogPath(levelName) { return fileForLevel(levelName); }

module.exports = {
  init, ts,
  debug, info, success, warn, error,
  auth, ipc, db,
  writeError,
  rotateIfNeeded, readLog, readAllLog, clearLog, clearAllLogs,
  getLogDir, getLogPath,
  LEVELS, LEVEL_FILES,
};
