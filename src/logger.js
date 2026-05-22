'use strict';

const fs = require('fs');
const path = require('path');

// ─── LOG FILE PATH ────────────────────────────────────────────────────────────
// Write to project directory (two levels up from src/)
const LOG_DIR = path.join(__dirname, '..');
const LOG_FILE = path.join(LOG_DIR, 'vault-debug.log');
const ERROR_FILE = path.join(LOG_DIR, 'vault-errors.log');

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
    // Write header for new session
    const header = `\n${'='.repeat(80)}\n[${ts()}] [INFO] ═══════════════════════════════════════════════════════\n[${ts()}] [INFO] Vault session started\n[${ts()}] [INFO] ═══════════════════════════════════════════════════════\n${'='.repeat(80)}\n`;
    fs.appendFileSync(LOG_FILE, header);
  } catch (e) {
    console.error('[logger] Failed to init log file:', e.message);
  }
}

// ─── TIMESTAMP ────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString(); }

// ─── CORE WRITE ───────────────────────────────────────────────────────────────
function write(level, ctx, msg, data) {
  init();
  const levelName = LEVEL_NAMES[level] || 'UNKNOWN';
  let line = `[${ts()}] [${levelName}] [${ctx}] ${msg}`;
  if (data !== undefined) {
    try {
      const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 0) : String(data);
      line += ` | data: ${dataStr}`;
    } catch { line += ' | data: [unserializable]'; }
  }
  line += '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  // Also mirror to console for dev
  if (level >= LEVELS.ERROR) console.error(line.trim());
  else if (level >= LEVELS.WARN) console.warn(line.trim());
  else console.log(line.trim());
}

// ─── ERROR FILE (dedicated error log) ─────────────────────────────────────────
function writeError(ctx, err) {
  init();
  const extra = err?.response?.data ? ` | response: ${JSON.stringify(err.response.data)}` : '';
  const line = `[${ts()}] [${ctx}] ${err?.message || err}${extra}\ncode: ${err?.code || 'none'} | status: ${err?.response?.status || 'none'}\n${err?.stack || ''}\n---\n`;
  try { fs.appendFileSync(ERROR_FILE, line); } catch {}
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
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > maxSize) {
      const rotated = LOG_FILE + '.' + Date.now() + '.bak';
      fs.renameSync(LOG_FILE, rotated);
      info('logger', 'Log file rotated', { from: LOG_FILE, to: rotated, size: stat.size });
    }
  } catch {}
}

// ─── READ LOG ─────────────────────────────────────────────────────────────────
function readLog(maxChars = 10000) {
  try {
    if (!fs.existsSync(LOG_FILE)) return '(no log file)';
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    return content.slice(-maxChars);
  } catch { return '(could not read log)'; }
}

function clearLog() {
  try { fs.writeFileSync(LOG_FILE, ''); return true; } catch { return false; }
}

function getLogPath() { return LOG_FILE; }
function getErrorLogPath() { return ERROR_FILE; }

module.exports = {
  init, ts,
  debug, info, success, warn, error,
  auth, ipc, db,
  writeError,
  rotateIfNeeded, readLog, clearLog,
  getLogPath, getErrorLogPath,
  LEVELS,
};
