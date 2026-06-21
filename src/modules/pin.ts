import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import type Electron from 'electron';
import type { DriveClient } from './drive';
import { enc, dec, derivePinKey } from './crypto';
import type { Session } from '../types';
import { storeToken, consumeToken } from './pintoken';

// ── PIN verify store: holds verified credentials between pin:verify and pin:completeLogin ──
// This prevents the token from traveling through the renderer process.
interface PinVerifyEntry {
  googleId: string;
  email: string;
  expiresAt: number;
}
const pinVerifyStore = new Map<string, PinVerifyEntry>();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pinVerifyStore) {
    if (val.expiresAt < now) pinVerifyStore.delete(key);
  }
}, 60_000);

function storePinVerify(googleId: string, email: string): string {
  const id = crypto.randomBytes(16).toString('hex');
  pinVerifyStore.set(id, { googleId, email, expiresAt: Date.now() + 30_000 });
  return id;
}
function consumePinVerify(id: string): { googleId: string; email: string } | null {
  const entry = pinVerifyStore.get(id);
  if (!entry) return null;
  pinVerifyStore.delete(id);
  if (entry.expiresAt < Date.now()) return null;
  return { googleId: entry.googleId, email: entry.email };
}

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
type GetSession = () => Session | null;

let _userDataPath: string = '';

function setUserDataPath(p: string): void {
  _userDataPath = p;
}

// ── PIN rate limiter (5 attempts per 15-min window, 15-min lockout) ──
const pinRateLimit = {
  attempts: [] as number[],
  lockoutUntil: 0,
  MAX_ATTEMPTS: 5,
  WINDOW_MS: 15 * 60 * 1000,
  LOCKOUT_MS: 15 * 60 * 1000,
};

function isPinRateLimited(): boolean {
  const now = Date.now();
  if (now < pinRateLimit.lockoutUntil) return true;
  pinRateLimit.attempts = pinRateLimit.attempts.filter(t => now - t < pinRateLimit.WINDOW_MS);
  if (pinRateLimit.attempts.length >= pinRateLimit.MAX_ATTEMPTS) {
    pinRateLimit.lockoutUntil = now + pinRateLimit.LOCKOUT_MS;
    return true;
  }
  return false;
}

function recordPinFailedAttempt(): void {
  const now = Date.now();
  pinRateLimit.attempts.push(now);
  if (pinRateLimit.attempts.length >= pinRateLimit.MAX_ATTEMPTS) {
    pinRateLimit.lockoutUntil = now + pinRateLimit.LOCKOUT_MS;
  }
}

function resetPinRateLimit(): void {
  pinRateLimit.attempts = [];
  pinRateLimit.lockoutUntil = 0;
}

// ── File path for encrypted user key ──
function getKeyfilePath(): string {
  const userData = _userDataPath
    || process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : path.join(process.env.HOME || '', '.config'));
  const dir = path.join(userData, 'Vault');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  return path.join(dir, 'vault_user_key');
}

function fileExists(): boolean {
  try { return fs.existsSync(getKeyfilePath()); } catch { return false; }
}

// ── PIN meta file (stores which googleId has a PIN, unencrypted) ──
// This is not sensitive — it only records that a PIN exists for a given googleId.
// The actual PIN hash and user key remain encrypted in vault_user_key.
function getMetafilePath(): string {
  const userData = _userDataPath
    || process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : path.join(process.env.HOME || '', '.config'));
  const dir = path.join(userData, 'Vault');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  return path.join(dir, 'vault_pin_meta');
}

function getPinGoogleId(): string | null {
  try {
    const raw = fs.readFileSync(getMetafilePath(), 'utf8');
    const data = JSON.parse(raw);
    return typeof data.googleId === 'string' ? data.googleId : null;
  } catch { return null; }
}

function setPinGoogleId(googleId: string): void {
  try {
    fs.writeFileSync(getMetafilePath(), JSON.stringify({ googleId }));
  } catch { /* noop */ }
}

function clearPinGoogleId(): void {
  try {
    const p = getMetafilePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* noop */ }
}

// ── PIN validation ──
function validatePin(pin: string, allowAlpha: boolean): string | null {
  if (!pin || typeof pin !== 'string') return 'PIN is required';
  if (pin.length < 4 || pin.length > 12) return 'PIN must be 4-12 characters';
  if (!allowAlpha && !/^\d{4,12}$/.test(pin)) return 'PIN must be 4-12 digits';
  if (allowAlpha && !/^[a-zA-Z0-9]{4,12}$/.test(pin)) return 'PIN must be 4-12 alphanumeric characters';
  return null;
}

// ── Get PIN allowAlpha setting ──
// allowAlpha is now stored inside the encrypted PIN payload, so it can't be
// read without the PIN. The renderer reads it from vault_settings instead.
function getPinAllowAlpha(): boolean {
  return false;
}

// ── Register IPC handlers ──
function register(
  ipcMain: Electron.IpcMain,
  requireAuth: AuthWrapper,
  requireAuthNoArgs: AuthWrapper,
  getSession: GetSession,
  logger: Logger,
  logError: LogError,
  _driveClient?: DriveClient | null,
) {
  // ── pin:setup ──
  // Requires active session. Creates the encrypted user key file.
  ipcMain.handle('pin:setup', requireAuth(async (_e: Electron.IpcMainInvokeEvent, { pin, allowAlpha }: { pin: string; allowAlpha: boolean }) => {
    logger.ipcLog('pin:setup', 'PIN setup requested');
    try {
      const session = getSession();
      if (!session) {
        logger.warn('pin:setup', 'No session found');
        return { ok: false, error: 'No active session' };
      }

      if (fileExists()) {
        logger.warn('pin:setup', 'PIN already exists — use pin:change instead');
        return { ok: false, error: 'PIN is already set. Use change PIN instead.' };
      }

      const pinErr = validatePin(pin, allowAlpha);
      if (pinErr) {
        logger.warn('pin:setup', 'Invalid PIN format', { error: pinErr });
        return { ok: false, error: pinErr };
      }

      const salt = crypto.randomBytes(32);
      const pinKey = derivePinKey(pin, salt);
      const pinHash = crypto.pbkdf2Sync(pin, salt, 600000, 32, 'sha256').toString('hex');

      const payload = { pinHash, userKey: { googleId: session.googleId, email: session.email }, allowAlpha };
      const encrypted = enc(payload, pinKey);

      const fileData = JSON.stringify({ version: 1, salt: salt.toString('base64'), data: encrypted });
      fs.writeFileSync(getKeyfilePath(), fileData);
      setPinGoogleId(session.googleId);

      logger.authLog('pin:setup', 'PIN configured successfully', { email: session.email });
      logger.success('pin:setup', 'User key file created');
      return { ok: true };
    } catch (e: unknown) {
      const err = e as Error;
      logger.error('pin:setup', 'Failed', err.message);
      logError('pin:setup', err);
      return { ok: false, error: 'Failed to set up PIN' };
    }
  }));

  // ── pin:verify ──
  // NO auth required — this is how the user gets a session via PIN
  // Rate limited: 5 attempts per 15-min window, 15-min lockout
  ipcMain.handle('pin:verify', async (_e: Electron.IpcMainInvokeEvent, { pin }: { pin: string }) => {
    logger.ipcLog('pin:verify', 'PIN verification attempt');
    try {
      if (isPinRateLimited()) {
        logger.warn('pin:verify', 'PIN verification rate limited');
        return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' };
      }

      if (!fileExists()) {
        logger.warn('pin:verify', 'No user key file found');
        return { ok: false, error: 'Invalid PIN' };
      }

      const fileContent = fs.readFileSync(getKeyfilePath(), 'utf8');
      const fileData = JSON.parse(fileContent);

      if (!fileData.version || !fileData.salt || !fileData.data) {
        logger.error('pin:verify', 'Corrupted user key file');
        return { ok: false, error: 'PIN data corrupted. Please sign in with Google to reset.' };
      }

      const salt = Buffer.from(fileData.salt, 'base64');
      const pinKey = derivePinKey(pin, salt);

      // Decrypt the payload
      const payload = dec(fileData.data, pinKey) as { pinHash: string; userKey: { googleId: string; email: string } } | null;
      if (!payload || typeof payload.pinHash !== 'string' || !payload.userKey
        || typeof payload.userKey.googleId !== 'string' || !payload.userKey.googleId
        || typeof payload.userKey.email !== 'string') {
        recordPinFailedAttempt();
        logger.authLog('pin:verify', 'PIN verification failed — decryption or validation failed');
        logger.warn('pin:verify', 'Incorrect PIN attempt');
        return { ok: false, error: 'Invalid PIN' };
      }

      // Verify the pinHash matches — constant-time to prevent timing attacks
      const computedHash = crypto.pbkdf2Sync(pin, salt, 600000, 32, 'sha256').toString('hex');
      const computedBuf = Buffer.from(computedHash, 'hex');
      const storedBuf = Buffer.from(payload.pinHash, 'hex');
      if (computedBuf.length !== storedBuf.length || !crypto.timingSafeEqual(computedBuf, storedBuf)) {
        recordPinFailedAttempt();
        logger.authLog('pin:verify', 'PIN verification failed — hash mismatch');
        logger.warn('pin:verify', 'Incorrect PIN attempt');
        return { ok: false, error: 'Invalid PIN' };
      }

      resetPinRateLimit();
      const { googleId, email } = payload.userKey;
      logger.authLog('pin:verify', 'PIN verified successfully', { email });
      logger.debug('pin:verify', 'Deriving encryption key', { googleId: googleId.slice(0, 8) + '...' });

      // Store verified credentials in-memory; renderer gets a verifyId (not the token)
      const verifyId = storePinVerify(googleId, email);

      logger.success('pin:verify', 'PIN verified', { email });
      // Return email for display/logging, but NOT googleId or token
      return { ok: true, verifyId, email };
    } catch (e: unknown) {
      const err = e as Error;
      logger.error('pin:verify', 'Error', err.message);
      logError('pin:verify', err);
      return { ok: false, error: 'Verification failed' };
    }
  });

  // ── pin:change ──
  // Requires active session. Verifies old PIN, writes new file.
  ipcMain.handle('pin:change', requireAuth(async (_e: Electron.IpcMainInvokeEvent, { oldPin, newPin, allowAlpha }: { oldPin: string; newPin: string; allowAlpha: boolean }) => {
    logger.ipcLog('pin:change', 'PIN change requested');
    try {
      const session = getSession();
      if (!session) {
        logger.warn('pin:change', 'No session found');
        return { ok: false, error: 'No active session' };
      }

      if (!fileExists()) {
        logger.warn('pin:change', 'No user key file found');
        return { ok: false, error: 'No PIN is currently set' };
      }

      // Rate limit old PIN verification (same limits as pin:verify)
      if (isPinRateLimited()) {
        logger.warn('pin:change', 'PIN change rate limited');
        return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' };
      }

      // Verify old PIN first
      const fileContent = fs.readFileSync(getKeyfilePath(), 'utf8');
      const fileData = JSON.parse(fileContent);
      const salt = Buffer.from(fileData.salt, 'base64');
      const oldPinKey = derivePinKey(oldPin, salt);
      const payload = dec(fileData.data, oldPinKey) as { pinHash: string; userKey: { googleId: string; email: string }; allowAlpha?: boolean } | null;
      if (!payload) {
        recordPinFailedAttempt();
        logger.warn('pin:change', 'Old PIN verification failed');
        return { ok: false, error: 'Current PIN is incorrect' };
      }

      const pinErr = validatePin(newPin, allowAlpha);
      if (pinErr) {
        logger.warn('pin:change', 'Invalid new PIN format', { error: pinErr });
        return { ok: false, error: pinErr };
      }

      // Write new file with new PIN — allowAlpha stored inside encrypted payload
      const newSalt = crypto.randomBytes(32);
      const newPinKey = derivePinKey(newPin, newSalt);
      const newPinHash = crypto.pbkdf2Sync(newPin, newSalt, 600000, 32, 'sha256').toString('hex');
      const newPayload = { pinHash: newPinHash, userKey: payload.userKey, allowAlpha };
      const newEncrypted = enc(newPayload, newPinKey);
      const newFileData = JSON.stringify({ version: 1, salt: newSalt.toString('base64'), data: newEncrypted });
      fs.writeFileSync(getKeyfilePath(), newFileData);
      resetPinRateLimit();

      logger.authLog('pin:change', 'PIN changed successfully', { email: session.email });
      logger.success('pin:change', 'User key file updated');
      return { ok: true };
    } catch (e: unknown) {
      const err = e as Error;
      logger.error('pin:change', 'Failed', err.message);
      logError('pin:change', err);
      return { ok: false, error: 'Failed to change PIN' };
    }
  }));

  // ── pin:disable ──
  // Requires active session. Deletes the user key file.
  ipcMain.handle('pin:disable', requireAuthNoArgs(async () => {
    logger.ipcLog('pin:disable', 'PIN disable requested');
    try {
      const session = getSession();
      if (fileExists()) {
        fs.unlinkSync(getKeyfilePath());
        clearPinGoogleId();
        logger.authLog('pin:disable', 'PIN disabled', { email: session?.email });
        logger.success('pin:disable', 'User key file deleted');
      } else {
        logger.warn('pin:disable', 'No user key file to delete');
      }

      return { ok: true };
    } catch (e: unknown) {
      const err = e as Error;
      logger.error('pin:disable', 'Failed', err.message);
      logError('pin:disable', err);
      return { ok: false, error: 'Failed to disable PIN' };
    }
  }));

  // ── pin:status ──
  // No auth required — checks if the key file exists.
  // Used by the renderer on startup to decide which screen to show.
  // Note: allowAlpha is no longer returned here since it's stored inside the
  // encrypted PIN payload. The renderer reads it from vault_settings instead.
  ipcMain.handle('pin:status', async () => {
    logger.ipcLog('pin:status', 'PIN status check');
    const enabled = fileExists();
    logger.debug('pin:status', 'Status', { enabled });
    return { ok: true, enabled };
  });

}

export { register, fileExists, setUserDataPath, consumePinVerify, getPinGoogleId, setPinGoogleId, clearPinGoogleId };
