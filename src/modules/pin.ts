import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import type Electron from 'electron';
import { enc, dec, derivePinKey } from './crypto';
import type { Session } from '../types';

type Logger = {
  db: (ctx: string, msg: string, data?: unknown) => void;
  success: (ctx: string, msg: string, data?: unknown) => void;
  warn: (ctx: string, msg: string, data?: unknown) => void;
  ipc: (ctx: string, msg: string, data?: unknown) => void;
  auth: (ctx: string, msg: string, data?: unknown) => void;
  error: (ctx: string, msg: string, data?: unknown) => void;
  debug: (ctx: string, msg: string, data?: unknown) => void;
};
type LogError = (ctx: string, err: unknown) => void;
type IpcHandler = (...args: any[]) => any;
type AuthWrapper = (fn: IpcHandler) => IpcHandler;
type GetSession = () => Session | null;

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
  const userData = process.env.APPDATA
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

// ── PIN validation ──
function validatePin(pin: string, allowAlpha: boolean): string | null {
  if (!pin || typeof pin !== 'string') return 'PIN is required';
  if (pin.length < 4 || pin.length > 12) return 'PIN must be 4-12 characters';
  if (!allowAlpha && !/^\d{4,12}$/.test(pin)) return 'PIN must be 4-12 digits';
  if (allowAlpha && !/^[a-zA-Z0-9]{4,12}$/.test(pin)) return 'PIN must be 4-12 alphanumeric characters';
  return null;
}

// ── Register IPC handlers ──
function register(
  ipcMain: Electron.IpcMain,
  requireAuth: AuthWrapper,
  requireAuthNoArgs: AuthWrapper,
  getSession: GetSession,
  logger: Logger,
  logError: LogError,
) {
  // ── pin:setup ──
  // Requires active session. Creates the encrypted user key file.
  ipcMain.handle('pin:setup', requireAuth(async (_e: Electron.IpcMainInvokeEvent, { pin, allowAlpha }: { pin: string; allowAlpha: boolean }) => {
    logger.ipc('pin:setup', 'PIN setup requested');
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

      const payload = { pinHash, userKey: { googleId: session.googleId, email: session.email } };
      const encrypted = enc(payload, pinKey);

      const fileData = JSON.stringify({ version: 1, salt: salt.toString('base64'), data: encrypted });
      fs.writeFileSync(getKeyfilePath(), fileData);

      logger.auth('pin:setup', 'PIN configured successfully', { email: session.email });
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
    logger.ipc('pin:verify', 'PIN verification attempt');
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
        logger.auth('pin:verify', 'PIN verification failed — decryption or validation failed');
        logger.warn('pin:verify', 'Incorrect PIN attempt');
        return { ok: false, error: 'Invalid PIN' };
      }

      // Verify the pinHash matches
      const computedHash = crypto.pbkdf2Sync(pin, salt, 600000, 32, 'sha256').toString('hex');
      if (computedHash !== payload.pinHash) {
        recordPinFailedAttempt();
        logger.auth('pin:verify', 'PIN verification failed — hash mismatch');
        logger.warn('pin:verify', 'Incorrect PIN attempt');
        return { ok: false, error: 'Invalid PIN' };
      }

      resetPinRateLimit();
      const { googleId, email } = payload.userKey;
      logger.auth('pin:verify', 'PIN verified successfully', { email });
      logger.debug('pin:verify', 'Deriving encryption key', { googleId: googleId.slice(0, 8) + '...' });

      // Return googleId and email so the renderer can call auth:loginWithPin
      // to complete session creation in main.ts (which has access to supabase, deriveKey, etc.)
      logger.success('pin:verify', 'PIN verified', { email });
      return { ok: true, googleId, email };
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
    logger.ipc('pin:change', 'PIN change requested');
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

      // Verify old PIN first
      const fileContent = fs.readFileSync(getKeyfilePath(), 'utf8');
      const fileData = JSON.parse(fileContent);
      const salt = Buffer.from(fileData.salt, 'base64');
      const oldPinKey = derivePinKey(oldPin, salt);
      const payload = dec(fileData.data, oldPinKey) as { pinHash: string; userKey: { googleId: string; email: string } } | null;
      if (!payload) {
        logger.warn('pin:change', 'Old PIN verification failed');
        return { ok: false, error: 'Current PIN is incorrect' };
      }

            const pinErr = validatePin(newPin, allowAlpha);
      if (pinErr) {
        logger.warn('pin:change', 'Invalid new PIN format', { error: pinErr });
        return { ok: false, error: pinErr };
      }

      // Write new file with new PIN
      const newSalt = crypto.randomBytes(32);
      const newPinKey = derivePinKey(newPin, newSalt);
      const newPinHash = crypto.pbkdf2Sync(newPin, newSalt, 600000, 32, 'sha256').toString('hex');
      const newPayload = { pinHash: newPinHash, userKey: payload.userKey };
      const newEncrypted = enc(newPayload, newPinKey);
      const newFileData = JSON.stringify({ version: 1, salt: newSalt.toString('base64'), data: newEncrypted });
      fs.writeFileSync(getKeyfilePath(), newFileData);

      logger.auth('pin:change', 'PIN changed successfully', { email: session.email });
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
    logger.ipc('pin:disable', 'PIN disable requested');
    try {
      const session = getSession();
      if (fileExists()) {
        fs.unlinkSync(getKeyfilePath());
        logger.auth('pin:disable', 'PIN disabled', { email: session?.email });
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
  // No auth required — only checks if the key file exists (no sensitive data).
  // Used by the renderer on startup to decide which screen to show.
  ipcMain.handle('pin:status', async () => {
    logger.ipc('pin:status', 'PIN status check');
    const enabled = fileExists();
    logger.debug('pin:status', 'Status', { enabled });
    return { ok: true, enabled };
  });
}

export { register, fileExists };
