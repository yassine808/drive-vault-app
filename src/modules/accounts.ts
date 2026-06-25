import path from "node:path";
import fs from "node:fs";
import type Electron from "electron";
import { getPinGoogleId } from "./pin";

type Logger = {
  dbLog: (ctx: string, msg: string, data?: unknown) => void;
  success: (ctx: string, msg: string, data?: unknown) => void;
  warn: (ctx: string, msg: string, data?: unknown) => void;
  ipcLog: (ctx: string, msg: string, data?: unknown) => void;
  authLog: (ctx: string, msg: string, data?: unknown) => void;
  error: (ctx: string, msg: string, data?: unknown) => void;
  debug: (ctx: string, msg: string, data?: unknown) => void;
};
type LogError = (ctx: string, err: unknown) => void;
type IpcHandler = (...args: any[]) => any;
type AuthWrapper = (fn: IpcHandler) => IpcHandler;
type GetSession = () => import("../types").Session | null;

export interface SavedAccount {
  googleId: string;
  email: string;
  name: string;
  avatar: string | null;
  lastUsed: number;
}

let _userDataPath: string = "";

export function setUserDataPathAccounts(p: string): void {
  _userDataPath = p;
}

function getFallbackUserDataPath(): string {
  if (process.platform === "darwin") {
    return path.join(process.env.HOME || "", "Library", "Application Support");
  }
  return path.join(process.env.HOME || "", ".config");
}

function getAccountsFilePath(): string {
  const userData = _userDataPath || process.env.APPDATA || getFallbackUserDataPath();
  const dir = path.join(userData, "Vault");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "vault_accounts");
}

function loadAccounts(): SavedAccount[] {
  try {
    const file = getAccountsFilePath();
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (a: unknown): a is SavedAccount =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as SavedAccount).googleId === "string" &&
        typeof (a as SavedAccount).email === "string",
    );
  } catch {
    return [];
  }
}

function writeAccounts(accounts: SavedAccount[]): void {
  fs.writeFileSync(getAccountsFilePath(), JSON.stringify(accounts));
}

function register(
  ipcMain: Electron.IpcMain,
  requireAuthNoArgs: AuthWrapper,
  getSession: GetSession,
  logger: Logger,
  logError: LogError,
) {
  // ── accounts:list — no auth required (shown on PIN screen)
  // Only returns accounts that have a PIN configured
  ipcMain.handle("accounts:list", async () => {
    logger.ipcLog("accounts:list", "Listing saved accounts");
    try {
      const accounts = loadAccounts();
      // Sort by lastUsed descending
      accounts.sort((a, b) => b.lastUsed - a.lastUsed);
      // Filter: only show accounts that have a PIN set
      const pinGoogleId = getPinGoogleId();
      if (pinGoogleId) {
        const filtered = accounts.filter((a) => a.googleId === pinGoogleId);
        return { ok: true, accounts: filtered };
      }
      // No PIN configured — return empty list
      return { ok: true, accounts: [] };
    } catch (e: unknown) {
      const err = e as Error;
      logger.error("accounts:list", "Failed", err.message);
      logError("accounts:list", err);
      return { ok: true, accounts: [] };
    }
  });

  // ── accounts:save — requires auth (called after successful login)
  ipcMain.handle(
    "accounts:save",
    requireAuthNoArgs(async () => {
      logger.ipcLog("accounts:save", "Saving account");
      try {
        const session = getSession();
        if (!session) {
          logger.warn("accounts:save", "No session");
          return { ok: false, error: "No active session" };
        }

        const accounts = loadAccounts();
        const idx = accounts.findIndex((a) => a.googleId === session.googleId);
        const entry: SavedAccount = {
          googleId: session.googleId,
          email: session.email,
          name: session.name,
          avatar: session.avatar,
          lastUsed: Date.now(),
        };

        if (idx >= 0) {
          accounts[idx] = entry;
        } else {
          accounts.push(entry);
        }

        // Keep max 10 accounts
        if (accounts.length > 10) {
          accounts.sort((a, b) => b.lastUsed - a.lastUsed);
          accounts.splice(10);
        }

        writeAccounts(accounts);
        logger.success("accounts:save", "Account saved", {
          email: session.email,
        });
        return { ok: true };
      } catch (e: unknown) {
        const err = e as Error;
        logger.error("accounts:save", "Failed", err.message);
        logError("accounts:save", err);
        return { ok: false, error: "Failed to save account" };
      }
    }),
  );

  // ── accounts:remove — requires auth
  ipcMain.handle(
    "accounts:remove",
    requireAuthNoArgs(async () => {
      logger.ipcLog("accounts:remove", "Removing account");
      try {
        const session = getSession();
        if (!session) {
          logger.warn("accounts:remove", "No session");
          return { ok: false, error: "No active session" };
        }

        let accounts = loadAccounts();
        accounts = accounts.filter((a) => a.googleId !== session.googleId);
        writeAccounts(accounts);
        logger.success("accounts:remove", "Account removed", {
          email: session.email,
        });
        return { ok: true };
      } catch (e: unknown) {
        const err = e as Error;
        logger.error("accounts:remove", "Failed", err.message);
        logError("accounts:remove", err);
        return { ok: false, error: "Failed to remove account" };
      }
    }),
  );

  // ── accounts:removeById — no auth (removes a saved account by googleId from PIN screen)
  ipcMain.handle(
    "accounts:removeById",
    async (_e: Electron.IpcMainInvokeEvent, { googleId }: { googleId: string }) => {
      logger.ipcLog("accounts:removeById", "Removing account by ID", {
        googleId: googleId?.slice(0, 8),
      });
      try {
        if (typeof googleId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(googleId)) {
          return { ok: false, error: "Invalid account ID" };
        }
        let accounts = loadAccounts();
        const before = accounts.length;
        accounts = accounts.filter((a) => a.googleId !== googleId);
        if (accounts.length === before) {
          return { ok: false, error: "Account not found" };
        }
        writeAccounts(accounts);
        logger.success("accounts:removeById", "Account removed", {
          googleId: googleId.slice(0, 8),
        });
        return { ok: true };
      } catch (e: unknown) {
        const err = e as Error;
        logger.error("accounts:removeById", "Failed", err.message);
        logError("accounts:removeById", err);
        return { ok: false, error: "Failed to remove account" };
      }
    },
  );

  // ── accounts:touch — no auth (updates lastUsed when PIN login succeeds)
  ipcMain.handle(
    "accounts:touch",
    async (_e: Electron.IpcMainInvokeEvent, { googleId }: { googleId: string }) => {
      logger.ipcLog("accounts:touch", "Touching account", {
        googleId: googleId?.slice(0, 8),
      });
      try {
        if (typeof googleId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(googleId))
          return { ok: false };
        const accounts = loadAccounts();
        const idx = accounts.findIndex((a) => a.googleId === googleId);
        if (idx >= 0) {
          accounts[idx].lastUsed = Date.now();
          writeAccounts(accounts);
        }
        return { ok: true };
      } catch (e: unknown) {
        const err = e as Error;
        logger.error("accounts:touch", "Failed", err.message);
        logError("accounts:touch", err);
        return { ok: false };
      }
    },
  );
}

export { register };
