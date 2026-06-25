import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.join(__dirname, "..", "Logs");

const LEVEL_FILES: Record<string, string> = {
  DEBUG: "debug.log",
  INFO: "info.log",
  SUCCESS: "success.log",
  WARN: "warn.log",
  ERROR: "error.log",
  AUTH: "auth.log",
  IPC: "ipc.log",
  DB: "db.log",
};

const LEVELS: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  SUCCESS: 2,
  WARN: 3,
  ERROR: 4,
  AUTH: 5,
  IPC: 6,
  DB: 7,
};

const LEVEL_NAMES = ["DEBUG", "INFO", "SUCCESS", "WARN", "ERROR", "AUTH", "IPC", "DB"];

let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // noop
  }
}

function ts(): string {
  return new Date().toISOString();
}

function fileForLevel(levelName: string): string {
  const name = String(levelName).toUpperCase();
  const filename = LEVEL_FILES[name] || "unknown.log";
  return path.join(LOG_DIR, filename);
}

function sanitizeNewlines(value: string): string {
  return value.replaceAll("\n", String.raw`\n`).replaceAll("\r", "");
}

function write(level: number, ctx: string, msg: string, data?: unknown): void {
  init();
  const levelName = LEVEL_NAMES[level] || "UNKNOWN";
  const safeCtx = sanitizeNewlines(String(ctx));
  const safeMsg = sanitizeNewlines(String(msg));
  let line = `[${ts()}] [${safeCtx}] ${safeMsg}`;
  if (data !== undefined) {
    try {
      const dataStr =
        typeof data === "object" && data !== null
          ? JSON.stringify(data, null, 0)
          : data == null
            ? ""
            : String(data);
      line += ` | data: ${dataStr}`;
    } catch {
      line += " | data: [unserializable]";
    }
  }
  line += "\n";
  try {
    fs.appendFileSync(fileForLevel(levelName), line);
  } catch {
    // noop
  }
  try {
    fs.appendFileSync(path.join(LOG_DIR, "all.log"), `[${levelName}] ${line}`);
  } catch {
    // noop
  }
}

function writeError(ctx: string, err: unknown): void {
  init();
  const e = err as {
    message?: string;
    code?: string | number;
    stack?: string;
    response?: { data?: unknown; status?: number };
  };
  const extra = e?.response?.data ? ` | response: ${JSON.stringify(e.response.data)}` : "";
  const line = `[${ts()}] [${ctx}] ${e?.message || String(err)}${extra}\ncode: ${e?.code || "none"} | status: ${e?.response?.status || "none"}\n${e?.stack || ""}\n---\n`;
  try {
    fs.appendFileSync(fileForLevel("ERROR"), line);
  } catch {
    // noop
  }
}

function debug(ctx: string, msg: string, data?: unknown): void {
  write(LEVELS.DEBUG, ctx, msg, data);
}
function info(ctx: string, msg: string, data?: unknown): void {
  write(LEVELS.INFO, ctx, msg, data);
}
function success(ctx: string, msg: string, data?: unknown): void {
  write(LEVELS.SUCCESS, ctx, msg, data);
}
function warn(ctx: string, msg: string, data?: unknown): void {
  write(LEVELS.WARN, ctx, msg, data);
}
function error(ctx: string, msg: string, data?: unknown): void {
  write(LEVELS.ERROR, ctx, msg, data);
}
function authLog(ctx: string, msg: string, data?: unknown): void {
  write(LEVELS.AUTH, ctx, msg, data);
}
function ipcLog(ctx: string, msg: string, data?: unknown): void {
  write(LEVELS.IPC, ctx, msg, data);
}
function dbLog(ctx: string, msg: string, data?: unknown): void {
  write(LEVELS.DB, ctx, msg, data);
}

function rotateFile(filePath: string, maxSize: number): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxSize) {
      const rotated = filePath + "." + Date.now() + ".bak";
      fs.renameSync(filePath, rotated);
    }
  } catch {
    // noop
  }
}

function rotateIfNeeded(maxSize: number = 5 * 1024 * 1024): void {
  init();
  try {
    for (const filename of Object.values(LEVEL_FILES)) {
      rotateFile(path.join(LOG_DIR, filename), maxSize);
    }
    rotateFile(path.join(LOG_DIR, "all.log"), maxSize);
    try {
      const files = fs.readdirSync(LOG_DIR);
      const now = Date.now();
      for (const f of files) {
        if (f.endsWith(".bak")) {
          const filePath = path.join(LOG_DIR, f);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
            fs.unlinkSync(filePath);
          }
        }
      }
    } catch {
      // noop
    }
  } catch {
    // noop
  }
}

function readLog(levelName: string, maxChars: number = 10000): string {
  try {
    const filePath = fileForLevel(levelName);
    if (!fs.existsSync(filePath)) return `(no ${levelName.toLowerCase()}.log file)`;
    const content = fs.readFileSync(filePath, "utf8");
    return content.slice(-maxChars);
  } catch {
    return `(could not read ${levelName.toLowerCase()}.log)`;
  }
}

function readAllLog(maxChars: number = 10000): string {
  try {
    const allPath = path.join(LOG_DIR, "all.log");
    if (!fs.existsSync(allPath)) return "(no all.log file)";
    const content = fs.readFileSync(allPath, "utf8");
    return content.slice(-maxChars);
  } catch {
    return "(could not read all.log)";
  }
}

function clearLog(levelName: string): boolean {
  try {
    fs.writeFileSync(fileForLevel(levelName), "");
    return true;
  } catch {
    return false;
  }
}

function clearAllLogs(): boolean {
  init();
  try {
    for (const filename of Object.values(LEVEL_FILES)) {
      fs.writeFileSync(path.join(LOG_DIR, filename), "");
    }
    fs.writeFileSync(path.join(LOG_DIR, "all.log"), "");
    return true;
  } catch {
    return false;
  }
}

function getLogDir(): string {
  return LOG_DIR;
}
function getLogPath(levelName: string): string {
  return fileForLevel(levelName);
}

export {
  init,
  ts,
  debug,
  info,
  success,
  warn,
  error,
  authLog,
  ipcLog,
  dbLog,
  writeError,
  rotateIfNeeded,
  readLog,
  readAllLog,
  clearLog,
  clearAllLogs,
  getLogDir,
  getLogPath,
  LEVELS,
  LEVEL_FILES,
};

// Re-export dbLog as 'db' for backward compat with main.ts
export { dbLog as db };

export default {
  init,
  debug,
  info,
  success,
  warn,
  error,
  authLog,
  ipcLog,
  db: dbLog,
  writeError,
  readLog,
  clearAllLogs,
  getLogDir,
};
