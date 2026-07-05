"use strict";

import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import electron from "electron";
const { ipcMain, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } = electron;
const { app } = electron;
import http from "node:http";
import url from "node:url";
import crypto from "node:crypto";

import type { DeletableType } from "./modules/drive";
import * as logger from "./logger";
logger.init();
logger.info("main", "Main process starting");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    logger.error("config", `Missing required environment variable: ${name}`);
    if (app.isReady()) {
      dialog.showErrorBox(
        "Configuration Error",
        `Missing required environment variable: ${name}\n\nPlease ensure a .env file is present.`,
      );
    }
    process.exit(1);
  }
  logger.debug("config", `Loaded env var: ${name}`);
  return v;
}

type GoogleProfile = {
  googleId: string;
  email: string;
  name: string;
  avatar: string | null;
};

const GOOGLE_CLIENT_ID = requireEnv("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = requireEnv("GOOGLE_CLIENT_SECRET");
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:42813/oauth2callback";
const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"];

logger.info("config", "Environment loaded", { redirectUri: REDIRECT_URI });

const LOG_PATH = path.join(
  process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) || app.getPath("userData"),
  "vault-errors.log",
);
logger.info("main", "Log paths", {
  logDir: logger.getLogDir(),
  errorLog: LOG_PATH,
});

function logError(ctx: string, err: unknown): void {
  logger.writeError(ctx, err);
}
process.on("uncaughtException", (e: Error) => {
  logger.error("uncaughtException", e.message, { stack: e.stack });
  logError("uncaughtException", e);
});
process.on("unhandledRejection", (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? e.stack : undefined;
  logger.error("unhandledRejection", msg, { stack });
  if (e instanceof Error) logError("unhandledRejection", e);
});
logger.info("main", "Global error handlers registered");

let win: electron.BrowserWindow | null = null;
let driveClient: import("./modules/drive").DriveClient | null = null;
let updateDriveClient: (dc: import("./modules/drive").DriveClient | null) => void = () => {};
let CryptoJS: any = null;
let speakeasy: any = null;
let tray: electron.Tray | null = null;
let oauthInProgress = false;
let oauthServer: http.Server | null = null;
let oauth2Client: any = null;

import * as authModule from "./modules/auth";
import {
  deriveKey,
  generateUserSalt,
  enc,
  dec,
  decWithFallback,
  setCryptoJS,
} from "./modules/crypto";
import * as validation from "./modules/validation";
import type { Session } from "./types";

const {
  genSessionToken,
  clearSession,
  setSession,
  getSession,
  requireAuth,
  requireAuthNoArgs,
  isRateLimited,
  recordFailedAttempt,
  resetRateLimit,
} = authModule;

const { MAX_NOTES_LEN, sanitizeStr, validType } = validation;

// ── Drive-backed data operations ──

async function driveLoadItems(
  encKey: string,
  googleId?: string,
  userSalt?: string,
): Promise<{
  passwords: Record<string, unknown>[];
  notes: Record<string, unknown>[];
}> {
  logger.db("driveLoadItems", "Loading vault items from cache");
  if (!driveClient) throw new TypeError("Drive not initialized");

  // Force-flush any pending changes first
  await driveClient.syncToDrive();

  // Use decWithFallback if we have salt info — tries PBKDF2 key first,
  // falls back to legacy SHA-256 key for items encrypted before salt was added.
  const decryptFn = (data: string) => {
    if (googleId && userSalt) {
      return decWithFallback(data, googleId, userSalt);
    }
    return dec(data, encKey);
  };

  const passwords: Record<string, unknown>[] = [],
    notes: Record<string, unknown>[] = [];

  for (const item of driveClient.loadItems("password")) {
    const decrypted = decryptFn(item.encryptedData);
    if (!decrypted) {
      logger.warn("driveLoadItems", "Failed to decrypt password", {
        id: item.id,
      });
      continue;
    }
    (decrypted as Record<string, unknown>)._localId = item.id;
    (decrypted as Record<string, unknown>)._sort = item.sortOrder;
    passwords.push(decrypted as Record<string, unknown>);
  }
  for (const item of driveClient.loadItems("note")) {
    const decrypted = decryptFn(item.encryptedData);
    if (!decrypted) {
      logger.warn("driveLoadItems", "Failed to decrypt note", { id: item.id });
      continue;
    }
    (decrypted as Record<string, unknown>)._localId = item.id;
    (decrypted as Record<string, unknown>)._sort = item.sortOrder;
    notes.push(decrypted as Record<string, unknown>);
  }

  logger.db("driveLoadItems", "Items loaded", {
    passwords: passwords.length,
    notes: notes.length,
  });
  return { passwords, notes };
}

async function driveLoadTrash(encKey: string): Promise<Record<string, unknown>[]> {
  logger.db("driveLoadTrash", "Loading trash from cache");
  if (!driveClient) throw new TypeError("Drive not initialized");

  const items: Record<string, unknown>[] = [];
  for (const type of ["password", "note"] as const) {
    for (const item of driveClient.loadTrash(type)) {
      const decrypted = dec(item.encryptedData, encKey);
      if (!decrypted) continue;
      items.push({
        ...decrypted,
        _localId: item.id,
        _type: type,
        _deletedAt: item.deletedAt,
      });
    }
  }
  logger.db("driveLoadTrash", "Trash loaded", { count: items.length });
  return items;
}

type ItemType = "password" | "note" | "job" | "totp";

interface Drive2fa {
  secret: string;
  enabled: boolean;
}

async function driveSaveItem(
  type: string,
  item: Record<string, unknown>,
  encKey: string,
): Promise<string> {
  logger.db("driveSaveItem", "Saving item", { type, localId: item?._localId });
  if (!driveClient) throw new TypeError("Drive not initialized");

  const { _localId, _sort, ...payload } = item;
  const encryptedData = enc(payload as object, encKey);
  const id = driveClient.saveItem(
    type as ItemType,
    encryptedData,
    _localId as string | undefined,
    _sort as number | undefined,
  );
  logger.db("driveSaveItem", "Item saved", { type, id });
  return id;
}

async function driveSoftDelete(localId: string, type: string): Promise<void> {
  logger.db("driveSoftDelete", "Soft-deleting item", { localId, type });
  if (!driveClient) throw new TypeError("Drive not initialized");
  driveClient.softDelete(type as DeletableType, localId);
  logger.db("driveSoftDelete", "Success", { localId });
}

async function driveRestore(localId: string, type: string): Promise<void> {
  logger.db("driveRestore", "Restoring item", { localId, type });
  if (!driveClient) throw new TypeError("Drive not initialized");
  driveClient.restore(type as DeletableType, localId);
  logger.db("driveRestore", "Success", { localId });
}

async function drivePermDelete(localId: string, type: string): Promise<void> {
  logger.db("drivePermDelete", "Permanently deleting item", { localId, type });
  if (!driveClient) throw new TypeError("Drive not initialized");
  driveClient.permDelete(type as "password" | "note" | "job" | "totp", localId);
  logger.db("drivePermDelete", "Success", { localId });
}

async function driveUpdateSortOrder(
  items: Array<{ _localId?: string }>,
  type: string,
): Promise<void> {
  logger.db("driveUpdateSortOrder", "Updating sort order", {
    count: items?.length,
  });
  if (!driveClient) throw new TypeError("Drive not initialized");
  driveClient.updateSortOrder(
    type as Exclude<ItemType, "totp">,
    items.map((i) => ({ id: i._localId || "" })),
  );
  logger.db("driveUpdateSortOrder", "Success");
}

async function drive2faGet(): Promise<Drive2fa | null> {
  logger.db("drive2faGet", "Getting 2FA record");
  if (!driveClient) throw new TypeError("Drive not initialized");
  return driveClient.load2fa();
}

async function drive2faSave(secret: string, enabled: boolean): Promise<void> {
  logger.db("drive2faSave", "Saving 2FA record", { enabled });
  if (!driveClient) throw new TypeError("Drive not initialized");
  await driveClient.save2fa(secret, enabled);
}

function verify2fa(secret: string, token: string): boolean {
  try {
    return speakeasy!.totp.verify({
      secret,
      encoding: "base32",
      token,
      window: 1,
    });
  } catch (e) {
    logger.warn("verify2fa", "TOTP verify threw", {
      message: (e as Error).message,
    });
    return false;
  }
}

/**
 * Persist OAuth tokens (refresh_token + access_token) encrypted at rest via
 * Electron's safeStorage, keyed to the account's cache settings. This lets
 * PIN login re-authenticate with Drive without a browser popup.
 */
function persistOAuthTokens(cacheSettings: Record<string, unknown>, tokens: unknown): void {
  try {
    if (!electron.safeStorage.isEncryptionAvailable()) {
      logger.warn("oauth", "safeStorage encryption unavailable — tokens not persisted");
      return;
    }
    const encrypted = electron.safeStorage.encryptString(JSON.stringify(tokens));
    cacheSettings.oauthTokens = encrypted.toString("base64");
  } catch (e) {
    logger.warn("oauth", "Failed to persist OAuth tokens", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function loadOAuthTokens(cacheSettings: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const stored = cacheSettings.oauthTokens as string | undefined;
    if (!stored) return null;
    if (!electron.safeStorage.isEncryptionAvailable()) return null;
    const decrypted = electron.safeStorage.decryptString(Buffer.from(stored, "base64"));
    return JSON.parse(decrypted);
  } catch (e) {
    logger.warn("oauth", "Failed to load stored OAuth tokens", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

async function googleOAuth(): Promise<GoogleProfile> {
  logger.authLog("oauth", "Starting OAuth flow");
  if (oauthServer) {
    try {
      oauthServer.close();
    } catch (e) {
      logger.warn("oauth", "OAuth server close failed", {
        message: (e as Error).message,
      });
    }
    oauthServer = null;
  }
  if (oauthInProgress) {
    oauthInProgress = false;
  }

  const google = await import("googleapis");
  oauth2Client = new google.google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    REDIRECT_URI,
  );
  const state = crypto.randomBytes(16).toString("hex");
  const stateCreatedAt = Date.now();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state,
    prompt: "consent",
  });
  logger.authLog("oauth", "OAuth URL generated", {
    state: state.slice(0, 8) + "...",
  });

  return new Promise((resolve, reject) => {
    oauthInProgress = true;
    oauthServer = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url || "", true);

      // Serve a clean "Signing in..." page at the root so the user sees
      // localhost:42813 in the browser instead of the full Google OAuth URL.
      if (parsed.pathname === "/") {
        const nonce = crypto.randomBytes(16).toString("base64");
        const html = `<!DOCTYPE html><html><head><title>Vault — Sign In</title>
<meta http-equiv="refresh" content="2;url=${authUrl}">
<style nonce="${nonce}">
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d0d;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:rgba(30,30,50,.8);border:1px solid rgba(139,92,246,.3);border-radius:16px;padding:40px;text-align:center;max-width:400px}
h2{color:#ffffff;margin-bottom:8px}
p{color:#94a3b8;font-size:14px}
a{color:#ffffff}
</style>
</head><body><div class="card">
<h2>Sign in with Google</h2>
<p>Redirecting to Google...</p>
<p style="margin-top:12px;font-size:12px"><a href="${authUrl}">Click here if not redirected</a></p>
</div></body></html>`;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'nonce-" +
            nonce +
            "'; script-src 'nonce-" +
            nonce +
            "';",
        });
        res.end(html);
        return;
      }

      if (parsed.pathname !== "/oauth2callback") return;

      // Origin validation: the state parameter already provides CSRF protection.
      // We log mismatches for auditing but don't block — browsers may strip
      // Origin/Referer on cross-origin redirects (Google OAuth → localhost).
      const origin = req.headers["origin"] || req.headers["referer"];
      if (origin) {
        const isValidOrigin = (o: string): boolean => {
          try {
            const u = new URL(o);
            return (
              u.protocol === "http:" &&
              (u.host === "localhost:42813" || u.host === "127.0.0.1:42813")
            );
          } catch (e) {
            logger.warn("oauth", "Origin validation failed", {
              message: (e as Error).message,
            });
            return false;
          }
        };
        if (!isValidOrigin(origin)) {
          logger.authLog(
            "oauth",
            "OAuth callback origin mismatch (allowed — state provides CSRF protection)",
            { origin },
          );
        }
      } else {
        logger.authLog(
          "oauth",
          "OAuth callback received without Origin/Referer (allowed — state provides CSRF protection)",
        );
      }
      if (!oauthInProgress) {
        logger.authLog("oauth", "Rejected OAuth callback — no active flow");
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("OAuth session expired or already used");
        return;
      }

      // Validate state and code FIRST (before expiration check) — prevents
      // race conditions where a stale callback with valid state could replay
      // after a new flow has started.
      if (!parsed.query.code || parsed.query.state !== state) {
        logger.authLog("oauth", "OAuth state mismatch or missing code");
        oauthInProgress = false;
        oauthServer!.close();
        oauthServer = null;
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("OAuth state mismatch");
        return reject(new Error("OAuth state mismatch"));
      }

      // Now check expiration — state is valid, so this is a real timeout
      if (Date.now() - stateCreatedAt > 5 * 60 * 1000) {
        logger.authLog("oauth", "OAuth state expired");
        oauthInProgress = false;
        oauthServer!.close();
        oauthServer = null;
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("OAuth state expired");
        return reject(new Error("OAuth state expired"));
      }

      // Consume the state immediately — prevents replay attacks
      oauthInProgress = false;
      oauthServer!.close();
      oauthServer = null;

      const nonce = crypto.randomBytes(16).toString("base64");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "';",
      });
      res.end(`<!DOCTYPE html><html><head><title>Vault — Authenticated</title>
<style nonce="${nonce}">
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0d0d0d;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
  .card{background:rgba(30,30,50,.8);border:1px solid rgba(139,92,246,.3);border-radius:16px;padding:40px;text-align:center;max-width:400px}
  h2{color:#ffffff;margin-bottom:8px}
  p{color:#94a3b8;font-size:14px}
</style>
</head><body><div class="card"><h2>Authenticated!</h2><p>You can close this window.</p>
<script nonce="${nonce}">
// Clean the URL bar — remove all query params for security
	try { history.replaceState({}, document.title, window.location.pathname); } catch(e) {}
	setTimeout(()=>window.close(),5000);
</script>
</div></body></html>`);

      if (win) {
        win.show();
        win.focus();
        if (win.isMinimized()) win.restore();
      }
      logger.authLog("oauth", "OAuth callback received, exchanging code for tokens");
      try {
        const { tokens } = await oauth2Client.getToken(parsed.query.code as string);
        oauth2Client.setCredentials(tokens);
        const people = google.google.people({
          version: "v1",
          auth: oauth2Client,
        });
        const me = await people.people.get({
          resourceName: "people/me",
          personFields: "emailAddresses,names,photos,metadata",
        });
        const profile: GoogleProfile = {
          googleId:
            (me.data.resourceName || "").replace("people/", "") ||
            (me.data.metadata?.sources?.find((s) => s.type === "PROFILE")?.id as string) ||
            (me.data.emailAddresses?.[0]?.value as string) ||
            "",
          email: (me.data.emailAddresses?.[0]?.value as string) || "",
          name: (me.data.names?.[0]?.displayName as string) || "",
          avatar: (me.data.photos?.[0]?.url as string) || null,
        };
        if (!profile.googleId) {
          throw new Error("Could not determine a stable Google account ID");
        }
        logger.authLog("oauth", "OAuth success", {
          email: profile.email,
          name: profile.name,
        });
        resolve(profile);
      } catch (e) {
        logger.authLog("oauth", "OAuth token exchange failed", {
          message: (e as Error).message,
        });
        reject(e);
      }
    });
    oauthServer.on("error", (err: NodeJS.ErrnoException) => {
      logger.authLog("oauth", "OAuth server failed to start", { message: err.message });
      oauthInProgress = false;
      reject(err);
    });
    oauthServer.listen(42813, "127.0.0.1", () => {
      logger.authLog("oauth", "OAuth server listening on 127.0.0.1:42813");
      // Open Google auth directly — skip the intermediate redirect page.
      // openExternal occasionally fails silently (e.g. default-browser
      // resolution race on some OSes) — retry once if it does.
      shell.openExternal(authUrl).catch((err) => {
        logger.warn("oauth", "openExternal failed, retrying once", {
          message: err instanceof Error ? err.message : String(err),
        });
        setTimeout(() => {
          shell.openExternal(authUrl).catch((err2) => {
            logger.warn("oauth", "openExternal retry failed", {
              message: err2 instanceof Error ? err2.message : String(err2),
            });
          });
        }, 400);
      });
    });
    setTimeout(() => {
      try {
        if (oauthServer) {
          oauthServer.close();
          oauthServer = null;
        }
      } catch (e) {
        logger.warn("oauth", "OAuth timeout cleanup failed", {
          message: (e as Error).message,
        });
      }
      oauthInProgress = false;
      logger.authLog("oauth", "OAuth timed out after 180s");
      reject(new Error("OAuth timed out"));
    }, 180_000);
  });
}

function playSound(type: string): void {
  logger.debug("sound", `Playing sound: ${type}`);
  if (win) win.webContents.send("play-sound", type);
}

import { register as registerJobs } from "./modules/jobs";
import { register as registerTotp } from "./modules/totp";
import { register as registerSettings } from "./modules/settings";
import { register as registerLogo } from "./modules/logo";
import { consumePinVerify, register as registerPin, setUserDataPath } from "./modules/pin";
import { register as registerAccounts, setUserDataPathAccounts } from "./modules/accounts";
import { register as registerSync } from "./modules/sync";
import { DriveClient } from "./modules/drive";

const getSessionFn = getSession;

ipcMain.handle("auth:login", async () => {
  logger.ipcLog("auth:login", "Login attempt started");
  clearSession();
  if (oauthInProgress) {
    logger.warn("auth:login", "Login rejected — auth already in progress");
    return {
      ok: false,
      error: "Auth already in progress. Please complete it in your browser.",
    };
  }
  try {
    const profile = await googleOAuth();

    // Load or generate per-account salt for strong key derivation.
    // Try the local cache file first — if the user has logged in before
    // (even on another machine that synced the cache), the salt will be there.
    const cacheMod = await import("./modules/cache");
    const cachedData = cacheMod.loadCache(profile.googleId);
    let userSalt = (cachedData.settings as Record<string, unknown>)?.userSalt as string | undefined;
    if (!userSalt) {
      userSalt = generateUserSalt();
      logger.info("crypto", "Generated new per-account salt", {
        email: profile.email,
      });
    }

    const encKey = deriveKey(profile.googleId, userSalt);

    // Initialize Drive client with the OAuth2 credentials
    driveClient = new DriveClient(profile.googleId, encKey, logger as any);
    await driveClient.init(oauth2Client);
    updateDriveClient(driveClient);

    // Persist OAuth tokens (encrypted) so PIN login can re-authenticate with
    // Drive without a browser popup, and keep them fresh on auto-refresh.
    persistOAuthTokens(
      driveClient.cache.settings as Record<string, unknown>,
      oauth2Client.credentials,
    );
    oauth2Client.on("tokens", (t: Record<string, unknown>) => {
      if (driveClient) {
        persistOAuthTokens(driveClient.cache.settings as Record<string, unknown>, {
          ...oauth2Client.credentials,
          ...t,
        });
        cacheMod.saveCache(driveClient.cache);
      }
    });

    // Persist salt in settings so future logins use strong derivation
    driveClient.cache.settings = { ...driveClient.cache.settings, userSalt };
    cacheMod.saveCache(driveClient.cache);

    const twofa = await drive2faGet();
    if (twofa?.enabled) {
      const sess = {
        ...profile,
        userId: profile.googleId,
        encKey,
        pending2fa: true,
      };
      setSession(sess);
      logger.authLog("auth:login", "Login success — 2FA required", {
        email: profile.email,
      });
      return {
        ok: true,
        needs2fa: true,
        user: {
          name: profile.name,
          email: profile.email,
          avatar: profile.avatar,
        },
      };
    }
    const token = genSessionToken();
    const vault = await driveLoadItems(encKey, profile.googleId, userSalt);
    const sess = {
      ...profile,
      userId: profile.googleId,
      encKey,
      pending2fa: false,
    };
    setSession(sess);
    playSound("login");
    logger.authLog("auth:login", "Login success", { email: profile.email });
    return {
      ok: true,
      needs2fa: false,
      user: {
        name: profile.name,
        email: profile.email,
        avatar: profile.avatar,
      },
      token,
      vault,
    };
  } catch (e: unknown) {
    const err = e as Error;
    logger.authLog("auth:login", "Login failed", { message: err.message });
    logError("auth:login", err);
    if (
      err.message.includes("Google Drive API has not been used") ||
      err.message.includes("SERVICE_DISABLED")
    ) {
      return {
        ok: false,
        error:
          "Google Drive API is not enabled for this project. Please ask the admin to enable it in Google Cloud Console → APIs & Services → Google Drive API.",
      };
    }
    return { ok: false, error: "Authentication failed. Please try again." };
  }
});

ipcMain.handle(
  "auth:verify2fa",
  requireAuth(async (_e: electron.IpcMainInvokeEvent, { token }: { token: string }) => {
    logger.ipcLog("auth:verify2fa", "2FA verification attempt");
    try {
      if (isRateLimited()) {
        logger.warn("auth:verify2fa", "2FA rejected — rate limited");
        return {
          ok: false,
          error: "Too many attempts. Try again in 15 minutes.",
        };
      }
      if (typeof token !== "string" || !/^\d{6}$/.test(token)) {
        recordFailedAttempt();
        logger.warn("auth:verify2fa", "2FA rejected — invalid token format");
        return {
          ok: false,
          error: "Invalid code format. Enter a 6-digit number.",
        };
      }
      const s = getSession();
      if (!s?.pending2fa) {
        recordFailedAttempt();
        logger.warn("auth:verify2fa", "2FA rejected — no pending 2FA session");
        return { ok: false, error: "No pending 2FA" };
      }
      const twofa = await drive2faGet();
      if (!verify2fa(twofa!.secret, token)) {
        recordFailedAttempt();
        logger.warn("auth:verify2fa", "2FA rejected — invalid code");
        return { ok: false, error: "Invalid code" };
      }
      resetRateLimit();
      s.pending2fa = false;
      setSession(s);
      const newToken = genSessionToken();
      const vault = await driveLoadItems(s.encKey, s.googleId);
      playSound("login");
      logger.authLog("auth:verify2fa", "2FA verified successfully", {
        email: s.email,
      });
      return {
        ok: true,
        token: newToken,
        vault,
        user: { name: s.name, email: s.email, avatar: s.avatar },
      };
    } catch (e: unknown) {
      const err = e as Error;
      logger.error("auth:verify2fa", "2FA verification error", err.message);
      logError("auth:verify2fa", err);
      return { ok: false, error: "Verification failed. Please try again." };
    }
  }),
);

ipcMain.handle(
  "auth:logout",
  requireAuthNoArgs(async () => {
    const s = getSession();
    logger.ipcLog("auth:logout", "Logout", { user: s?.email });
    playSound("logout");
    // Flush Drive sync before clearing session
    if (driveClient) {
      try {
        await driveClient.close();
      } catch (e) {
        logger.warn("auth:logout", "Drive close failed during logout", {
          message: (e as Error).message,
        });
      }
      driveClient = null;
      updateDriveClient(null);
    }
    clearSession();
    logger.authLog("auth:logout", "Session cleared");
    return { ok: true };
  }),
);

ipcMain.handle(
  "auth:lock",
  requireAuthNoArgs(async () => {
    const s = getSession();
    logger.ipcLog("auth:lock", "Lock", { user: s?.email });
    clearSession();
    logger.authLog("auth:lock", "Session locked — full session cleared");
    return { ok: true };
  }),
);

ipcMain.handle("auth:reauth", async () => {
  logger.ipcLog("auth:reauth", "Re-authentication attempt");
  const prevSession = getSession();
  clearSession();
  if (oauthInProgress) {
    logger.warn("auth:reauth", "Reauth rejected — auth already in progress");
    return { ok: false, error: "Auth already in progress." };
  }
  try {
    const profile = await googleOAuth();
    if (prevSession && profile.googleId !== prevSession.googleId) {
      logger.warn("auth:reauth", "Reauth rejected — different account", {
        expected: prevSession.googleId,
        got: profile.googleId,
      });
      return { ok: false, error: "Different account" };
    }
    const cacheMod2 = await import("./modules/cache");
    const cachedData2 = cacheMod2.loadCache(profile.googleId);
    let userSalt2 = (cachedData2.settings as Record<string, unknown>)?.userSalt as
      | string
      | undefined;
    if (!userSalt2) {
      userSalt2 = generateUserSalt();
      logger.info("crypto", "Generated new per-account salt (reauth)", {
        email: profile.email,
      });
    }

    const encKey = deriveKey(profile.googleId, userSalt2);

    // Re-init Drive client
    driveClient = new DriveClient(profile.googleId, encKey, logger as any);
    await driveClient.init(oauth2Client);
    updateDriveClient(driveClient);

    driveClient.cache.settings = {
      ...driveClient.cache.settings,
      userSalt: userSalt2,
    };
    cacheMod2.saveCache(driveClient.cache);

    const vault = await driveLoadItems(encKey, profile.googleId, userSalt2);
    const sess = {
      ...profile,
      userId: profile.googleId,
      encKey,
      pending2fa: false,
    };
    setSession(sess);
    const token = genSessionToken();
    playSound("login");
    logger.authLog("auth:reauth", "Re-authentication success", {
      email: profile.email,
    });
    return {
      ok: true,
      user: {
        name: profile.name,
        email: profile.email,
        avatar: profile.avatar,
      },
      token,
      vault,
    };
  } catch (e: unknown) {
    const err = e as Error;
    logger.authLog("auth:reauth", "Re-authentication failed", {
      message: err.message,
    });
    logError("auth:reauth", err);
    if (
      err.message.includes("Google Drive API has not been used") ||
      err.message.includes("SERVICE_DISABLED")
    ) {
      return {
        ok: false,
        error:
          "Google Drive API is not enabled for this project. Please ask the admin to enable it in Google Cloud Console → APIs & Services → Google Drive API.",
      };
    }
    return { ok: false, error: "Re-authentication failed. Please try again." };
  }
});

ipcMain.handle(
  "auth:loginWithPin",
  async (_e: electron.IpcMainInvokeEvent, { verifyId }: { verifyId: string }) => {
    logger.ipcLog("auth:loginWithPin", "PIN login attempt");
    try {
      // Consume the PIN verify entry — proves pin:verify was just called successfully
      // This is done entirely in the main process; no token travels through the renderer
      const verified = consumePinVerify(verifyId);
      if (!verified) {
        logger.warn("auth:loginWithPin", "Invalid or expired PIN verify ID");
        return {
          ok: false,
          error: "PIN verification expired. Please enter your PIN again.",
        };
      }

      const { googleId, email } = verified;

      // Input validation
      if (typeof googleId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(googleId)) {
        return { ok: false, error: "Invalid session" };
      }
      if (typeof email !== "string" || !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/u.test(email)) {
        return { ok: false, error: "Invalid session" };
      }

      // Load or generate per-account salt for PIN login
      const pinCacheMod = await import("./modules/cache");
      const pinCached = pinCacheMod.loadCache(googleId);
      let pinSalt = (pinCached.settings as Record<string, unknown>)?.userSalt as string | undefined;
      if (!pinSalt) {
        // First PIN login on this machine — generate and persist
        pinSalt = generateUserSalt();
        logger.info("crypto", "Generated new per-account salt (PIN login)", {
          email,
        });
      }

      const encKey = deriveKey(googleId, pinSalt);

      // Rehydrate oauth2Client from stored (encrypted) tokens if we don't
      // already have a live one from this session — without this, PIN login
      // silently fell back to a cache-only client and nothing ever synced.
      if (!oauth2Client) {
        const storedTokens = loadOAuthTokens((pinCached.settings as Record<string, unknown>) || {});
        if (storedTokens) {
          const google = await import("googleapis");
          oauth2Client = new google.google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            REDIRECT_URI,
          );
          oauth2Client.setCredentials(storedTokens);
        }
      }

      // Try to initialize Drive client if we have OAuth tokens
      if (oauth2Client) {
        try {
          driveClient = new DriveClient(googleId, encKey, logger as any);
          await driveClient.init(oauth2Client);
          updateDriveClient(driveClient);
          // Keep persisted tokens fresh as the client auto-refreshes them
          oauth2Client.on("tokens", (t: Record<string, unknown>) => {
            if (driveClient) {
              persistOAuthTokens(driveClient.cache.settings as Record<string, unknown>, {
                ...oauth2Client.credentials,
                ...t,
              });
              pinCacheMod.saveCache(driveClient.cache);
            }
          });
        } catch (driveErr) {
          logger.warn("auth:loginWithPin", "Drive init failed, using local cache only", {
            error: driveErr instanceof Error ? driveErr.message : String(driveErr),
          });
          driveClient = null;
        }
      }

      // If driveClient is null (no OAuth or init failed), create a cache-only instance
      if (!driveClient) {
        driveClient = new DriveClient(googleId, encKey, logger as any);
        updateDriveClient(driveClient);
      }

      // Ensure salt is persisted in cache settings
      driveClient.cache.settings = {
        ...driveClient.cache.settings,
        userSalt: pinSalt,
      };
      pinCacheMod.saveCache(driveClient.cache);

      const vault = await driveLoadItems(encKey, googleId, pinSalt);
      const accountsMod = await import("./modules/accounts");
      const savedAccount = accountsMod.loadAccounts().find((a) => a.googleId === googleId);
      const sess: Session = {
        googleId,
        email,
        name: savedAccount?.name || email.split("@")[0],
        avatar: savedAccount?.avatar ?? null,
        userId: googleId,
        encKey,
        pending2fa: false,
      };
      setSession(sess);
      const token = genSessionToken();
      playSound("login");
      logger.authLog("auth:loginWithPin", "PIN login success", { email });
      return {
        ok: true,
        user: { name: sess.name, email, avatar: sess.avatar },
        token,
        vault,
      };
    } catch (e: unknown) {
      const err = e as Error;
      logger.authLog("auth:loginWithPin", "PIN login failed", {
        message: err.message,
      });
      logError("auth:loginWithPin", err);
      return {
        ok: false,
        error: "Login failed. Please try again or sign in with Google.",
      };
    }
  },
);

ipcMain.handle(
  "vault:save",
  requireAuth(
    async (
      _e: electron.IpcMainInvokeEvent,
      { type, item }: { type: string; item: Record<string, unknown> },
    ) => {
      const s = getSession()!;
      logger.ipcLog("vault:save", "Save vault item", {
        type,
        localId: item?._localId,
      });
      try {
        if (!validType(type)) {
          logger.warn("vault:save", "Invalid type", { type });
          return { ok: false, error: "Invalid item type" };
        }
        if (!item || typeof item !== "object") {
          logger.warn("vault:save", "Invalid item");
          return { ok: false, error: "Invalid item" };
        }
        item.site = sanitizeStr(item.site as string);
        item.username = sanitizeStr(item.username as string);
        item.password = sanitizeStr(item.password as string, MAX_NOTES_LEN);
        item.notes = sanitizeStr(item.notes as string, MAX_NOTES_LEN);
        const id = await driveSaveItem(type, item, s.encKey);
        logger.success("vault:save", "Item saved", { type, id });
        return { ok: true, id };
      } catch (e: unknown) {
        logError("vault:save", e);
        return { ok: false, error: "Operation failed" };
      }
    },
  ),
);

ipcMain.handle(
  "vault:delete",
  requireAuth(
    async (_e: electron.IpcMainInvokeEvent, { id, type }: { id: string; type: string }) => {
      logger.ipcLog("vault:delete", "Delete vault item", { id, type });
      try {
        await driveSoftDelete(id, type as Exclude<ItemType, "totp">);
        logger.success("vault:delete", "Item deleted", { id, type });
        return { ok: true };
      } catch (e: unknown) {
        logError("vault:delete", e);
        return { ok: false, error: "Operation failed" };
      }
    },
  ),
);

ipcMain.handle(
  "vault:sync",
  requireAuthNoArgs(async () => {
    const s = getSession()!;
    logger.ipcLog("vault:sync", "Syncing vault");
    try {
      if (driveClient) await driveClient.syncToDrive();
      const syncCacheMod = await import("./modules/cache");
      const syncCached = syncCacheMod.loadCache(s.googleId);
      const syncSalt = (syncCached.settings as Record<string, unknown>)?.userSalt as
        | string
        | undefined;
      const vault = await driveLoadItems(s.encKey, s.googleId, syncSalt);
      logger.success("vault:sync", "Vault synced", {
        passwords: vault.passwords.length,
        notes: vault.notes.length,
      });
      return { ok: true, vault };
    } catch (e: unknown) {
      logError("vault:sync", e);
      return { ok: false, error: "Operation failed" };
    }
  }),
);

ipcMain.handle(
  "vault:reorder",
  requireAuth(
    async (
      _e: electron.IpcMainInvokeEvent,
      { type, items }: { type: string; items: Array<{ _localId?: string }> },
    ) => {
      logger.ipcLog("vault:reorder", "Reordering items", {
        type,
        count: items?.length,
      });
      try {
        await driveUpdateSortOrder(items, type);
        logger.success("vault:reorder", "Items reordered");
        return { ok: true };
      } catch (e: unknown) {
        logError("vault:reorder", e);
        return { ok: false };
      }
    },
  ),
);

ipcMain.handle(
  "trash:load",
  requireAuthNoArgs(async () => {
    const s = getSession()!;
    logger.ipcLog("trash:load", "Loading trash");
    try {
      const items = await driveLoadTrash(s.encKey);
      logger.success("trash:load", "Trash loaded", { count: items.length });
      return { ok: true, items };
    } catch (e: unknown) {
      logError("trash:load", e);
      return { ok: false, error: "Operation failed" };
    }
  }),
);

ipcMain.handle(
  "trash:restore",
  requireAuth(
    async (_e: electron.IpcMainInvokeEvent, { id, type }: { id: string; type: string }) => {
      logger.ipcLog("trash:restore", "Restoring from trash", { id, type });
      try {
        await driveRestore(id, type as Exclude<ItemType, "totp">);
        logger.success("trash:restore", "Item restored", { id, type });
        return { ok: true };
      } catch (e: unknown) {
        logError("trash:restore", e);
        return { ok: false, error: "Operation failed" };
      }
    },
  ),
);

ipcMain.handle(
  "trash:purge",
  requireAuth(
    async (_e: electron.IpcMainInvokeEvent, { id, type }: { id: string; type: string }) => {
      logger.ipcLog("trash:purge", "Purging from trash", { id, type });
      try {
        await drivePermDelete(id, type as "password" | "note" | "job" | "totp");
        logger.success("trash:purge", "Item purged", { id, type });
        return { ok: true };
      } catch (e: unknown) {
        logError("trash:purge", e);
        return { ok: false, error: "Operation failed" };
      }
    },
  ),
);

ipcMain.handle(
  "2fa:status",
  requireAuthNoArgs(async () => {
    logger.ipcLog("2fa:status", "Checking 2FA status");
    try {
      const d = await drive2faGet();
      const enabled = d?.enabled || false;
      logger.success("2fa:status", "2FA status", { enabled });
      return { ok: true, enabled };
    } catch {
      logger.warn("2fa:status", "No 2FA record, defaulting to disabled");
      return { ok: true, enabled: false };
    }
  }),
);

ipcMain.handle(
  "2fa:setup",
  requireAuthNoArgs(async () => {
    const s = getSession()!;
    logger.ipcLog("2fa:setup", "Setting up 2FA");
    try {
      const existing = await drive2faGet();
      if (existing?.enabled) {
        logger.warn("2fa:setup", "2FA already enabled, cannot re-setup without disabling first");
        return {
          ok: false,
          error: "2FA is already enabled. Disable it first before setting up again.",
        };
      }
      const secret = speakeasy!.generateSecret({
        name: `Vault (${s.email})`,
        length: 20,
      });
      await drive2faSave(secret.base32, false);
      logger.success("2fa:setup", "2FA setup initiated");
      return { ok: true, secret: secret.base32, otpauth: secret.otpauth_url };
    } catch (e: unknown) {
      logError("2fa:setup", e);
      return { ok: false, error: "Operation failed" };
    }
  }),
);

ipcMain.handle(
  "2fa:enable",
  requireAuth(async (_e: electron.IpcMainInvokeEvent, { token }: { token: string }) => {
    logger.ipcLog("2fa:enable", "Enabling 2FA");
    try {
      if (isRateLimited()) {
        logger.warn("2fa:enable", "Rate limited");
        return {
          ok: false,
          error: "Too many attempts. Try again in 15 minutes.",
        };
      }
      if (typeof token !== "string" || !/^\d{6}$/.test(token)) {
        recordFailedAttempt();
        logger.warn("2fa:enable", "Invalid token format");
        return {
          ok: false,
          error: "Invalid code format. Enter a 6-digit number.",
        };
      }
      const d = await drive2faGet();
      if (!d || !verify2fa(d.secret, token)) {
        recordFailedAttempt();
        logger.warn("2fa:enable", "Invalid 2FA code");
        return { ok: false, error: "Invalid code" };
      }
      resetRateLimit();
      await drive2faSave(d.secret, true);
      logger.success("2fa:enable", "2FA enabled");
      return { ok: true };
    } catch (e: unknown) {
      logError("2fa:enable", e);
      return { ok: false, error: "Operation failed" };
    }
  }),
);

ipcMain.handle(
  "2fa:disable",
  requireAuth(async (_e: electron.IpcMainInvokeEvent, { token }: { token: string }) => {
    logger.ipcLog("2fa:disable", "Disabling 2FA");
    try {
      if (isRateLimited()) {
        logger.warn("2fa:disable", "Rate limited");
        return {
          ok: false,
          error: "Too many attempts. Try again in 15 minutes.",
        };
      }
      if (typeof token !== "string" || !/^\d{6}$/.test(token)) {
        recordFailedAttempt();
        logger.warn("2fa:disable", "Invalid token format");
        return {
          ok: false,
          error: "Enter your current 6-digit 2FA code to disable.",
        };
      }
      const d = await drive2faGet();
      if (!d || !verify2fa(d.secret, token)) {
        recordFailedAttempt();
        logger.warn("2fa:disable", "Invalid 2FA code");
        return { ok: false, error: "Invalid code" };
      }
      resetRateLimit();
      await drive2faSave(d.secret, false);
      logger.success("2fa:disable", "2FA disabled");
      return { ok: true };
    } catch (e: unknown) {
      logError("2fa:disable", e);
      return { ok: false, error: "Operation failed" };
    }
  }),
);

ipcMain.handle(
  "win:minimize",
  requireAuthNoArgs(() => {
    logger.ipcLog("win:minimize", "Window minimized");
    win?.minimize();
    return { ok: true };
  }),
);
ipcMain.handle(
  "win:maximize",
  requireAuthNoArgs(() => {
    logger.ipcLog("win:maximize", "Window maximize toggled");
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
    setTimeout(() => {
      if (!win!.isDestroyed()) win!.webContents.send("win:maximized-state", win!.isMaximized());
    }, 50);
    return { ok: true };
  }),
);
ipcMain.handle(
  "win:close",
  requireAuthNoArgs(() => {
    logger.ipcLog("win:close", "Window close requested — minimizing to tray");
    if (win) {
      if (process.platform === "darwin") {
        win.hide();
      } else {
        win.minimize();
        win.setSkipTaskbar(true);
      }
    }
    return { ok: true };
  }),
);

ipcMain.on(
  "preload:log",
  (
    _e: electron.IpcMainEvent,
    {
      action,
      channel,
      ok,
      detail,
    }: {
      action: string;
      channel: string;
      ok: boolean;
      detail?: Record<string, unknown>;
    },
  ) => {
    logger.ipcLog("preload", `Bridge call: ${channel}`, {
      action,
      ok,
      ...detail,
    });
  },
);
ipcMain.on("preload:token", (_e: electron.IpcMainEvent, state: string) => {
  logger.authLog("preload", `Token state: ${state}`);
});

function setupTray(): void {
  logger.info("tray", "Creating system tray icon");
  const iconPath = path.join(__dirname, "..", "icon.png");
  let trayIcon: electron.NativeImage;
  try {
    const img = nativeImage.createFromPath(iconPath);
    trayIcon = img.resize({ width: 16, height: 16 });
  } catch (e) {
    logger.warn("tray", "Failed to load tray icon, using empty", {
      message: (e as Error).message,
    });
    trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip("Vault");
  const buildTrayMenu = (): electron.Menu =>
    Menu.buildFromTemplate([
      {
        label: "Show Vault",
        click: () => {
          if (win) {
            win.show();
            win.focus();
            win.setSkipTaskbar(false);
          }
        },
      },
      { type: "separator" },
      {
        label: "Lock Vault",
        enabled: !!getSession(),
        click: () => {
          logger.info("tray", "Lock vault from tray");
          if (win) {
            win.webContents.send("tray:lock");
          }
        },
      },
      { type: "separator" },
      {
        label: "Logout",
        enabled: !!getSession(),
        click: () => {
          logger.info("tray", "Logout from tray");
          if (win) {
            win.webContents.send("tray:logout");
          }
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          logger.info("tray", "Quit from tray menu");
          (app as unknown as { isQuitting: boolean }).isQuitting = true;
          app.quit();
        },
      },
    ]);
  tray!.setContextMenu(buildTrayMenu());
  tray.on("right-click", () => {
    tray!.setContextMenu(buildTrayMenu());
  });
  tray.on("double-click", () => {
    if (win) {
      win.show();
      win.focus();
      win.setSkipTaskbar(false);
    }
  });
}

function createWindow(): void {
  logger.info("window", "Creating main window");
  if (!tray) setupTray();
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 580,
    frame: false,
    transparent: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: "#ffffff", height: 40 },
    icon: path.join(__dirname, "..", "icon.png"),
    backgroundColor: "#0d0d0d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  const builtIndex = path.join(__dirname, "..", "dist", "index.html");
  if (app.isPackaged || !process.argv.includes("--dev")) {
    win.loadFile(builtIndex);
  } else {
    win.loadURL("http://localhost:5173/index.html");
    win.webContents.openDevTools({ mode: "detach" });
  }

  win.webContents.on("will-navigate", (event, navUrl) => {
    const parsedUrl = new URL(navUrl);
    if (parsedUrl.protocol !== "file:") {
      logger.warn("security", "Blocked navigation to external URL", {
        url: navUrl,
      });
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    const parsedUrl = new URL(openUrl);
    if (parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:") {
      logger.info("security", "Opening external URL in system browser", {
        url: openUrl,
      });
      shell.openExternal(openUrl);
    } else {
      logger.warn("security", "Blocked new-window creation", { url: openUrl });
    }
    return { action: "deny" };
  });

  win.on("minimize", () => {
    win!.webContents.send("win:minimized");
  });
  win.on("close", (e) => {
    if (!(app as unknown as { isQuitting: boolean }).isQuitting) {
      e.preventDefault();
      if (process.platform === "darwin") {
        win!.hide();
      } else {
        win!.minimize();
        win!.setSkipTaskbar(true);
      }
    }
  });
  win.on("maximize", () => {
    if (!win!.isDestroyed()) win!.webContents.send("win:maximized-state", true);
  });
  win.on("unmaximize", () => {
    if (!win!.isDestroyed()) win!.webContents.send("win:maximized-state", false);
  });

  logger.success("window", "Main window created and loaded");
  if (process.argv.includes("--dev")) win.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => {
  logger.info("app", "Electron app ready");
  CryptoJS = require("crypto-js");
  setCryptoJS(CryptoJS);
  speakeasy = require("speakeasy");
  logger.success("app", "Dependencies loaded (CryptoJS, speakeasy)");

  // Register modules — pass getDriveClient getter (driveClient is null until login,
  // modules call the getter at invocation time so they get the live value)
  registerJobs({
    ipcMain,
    requireAuth,
    requireAuthNoArgs,
    getDriveClient: () => driveClient,
    _validation: validation,
    getSession: getSessionFn,
    logger: logger as any,
    enc,
    dec,
    logError,
  });
  registerTotp({
    ipcMain,
    requireAuth,
    requireAuthNoArgs,
    getDriveClient: () => driveClient,
    getSession: getSessionFn,
    logger: logger as any,
    enc,
    dec,
    logError,
  });
  registerSettings(
    ipcMain,
    requireAuth,
    requireAuthNoArgs,
    () => driveClient,
    getSessionFn,
    logger as any,
    logError,
  );
  registerLogo(ipcMain, requireAuth, () => driveClient, logger as any, getSessionFn, logError);
  setUserDataPath(app.getPath("userData"));
  setUserDataPathAccounts(app.getPath("userData"));
  registerPin(
    ipcMain,
    requireAuth,
    requireAuthNoArgs,
    getSessionFn,
    logger as any,
    logError,
    () => driveClient,
  );
  registerAccounts(ipcMain, requireAuthNoArgs, getSessionFn, logger as any, logError);
  updateDriveClient = registerSync(
    ipcMain,
    requireAuth,
    requireAuthNoArgs,
    () => driveClient,
    getSessionFn,
    logger as any,
    logError,
  ).updateDriveClient;

  createWindow();
});

app.on("window-all-closed", () => {
  logger.info("app", "All windows closed");
  if (process.platform !== "darwin") {
    logger.info("app", "Quitting app (non-macOS)");
    app.quit();
  }
});

app.on("activate", () => {
  logger.info("app", "App activated");
  if (!BrowserWindow.getAllWindows().length) {
    logger.info("app", "No windows — creating new one");
    createWindow();
  }
});

app.on("before-quit", async () => {
  logger.info("app", "App quitting — flushing Drive sync");
  if (driveClient) {
    try {
      await driveClient.close();
    } catch (e) {
      logger.warn("app", "Drive close failed during quit", {
        message: (e as Error).message,
      });
    }
  }
});