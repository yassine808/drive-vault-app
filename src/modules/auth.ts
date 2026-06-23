import crypto from "crypto";
import type { Session } from "../types";

const SESSION_TOKEN_MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours

interface RateLimitState {
  attempts: number[];
  lockoutUntil: number;
  readonly MAX_ATTEMPTS: number;
  readonly WINDOW_MS: number;
  readonly LOCKOUT_MS: number;
}

let _sessionToken: string | null = null;
let _sessionTokenCreated = 0;
let _session: Session | null = null;

function genSessionToken(): string {
  const t = crypto.randomBytes(32).toString("hex");
  _sessionToken = t;
  _sessionTokenCreated = Date.now();
  return t;
}

function validateToken(token: string): boolean {
  if (!_sessionToken) return false;
  if (typeof token !== "string" || token.length !== 64) return false;
  try {
    // Always create both buffers — use a dummy if token length is wrong
    // so that timingSafeEqual always runs with same-length args.
    const a =
      token.length === 64 ? Buffer.from(token, "hex") : Buffer.alloc(32);
    const b = Buffer.from(_sessionToken, "hex");
    // Timing-safe comparison regardless of input length
    const match = crypto.timingSafeEqual(a, b);
    if (!match) return false;
    if (Date.now() - _sessionTokenCreated > SESSION_TOKEN_MAX_AGE) {
      _sessionToken = null;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function clearSession(): void {
  _sessionToken = null;
  _sessionTokenCreated = 0;
  _session = null;
}

function setSession(session: Session | null): void {
  _session = session;
}

function getSession(): Session | null {
  return _session;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcMainHandler = (
  event: Electron.IpcMainInvokeEvent,
  ...args: any[]
) => any;

function requireAuth(fn: IpcMainHandler): IpcMainHandler {
  return async (
    event: Electron.IpcMainInvokeEvent,
    token: string,
    ...args: unknown[]
  ) => {
    if (!validateToken(token)) {
      return { ok: false, error: "Not authenticated" };
    }
    try {
      return await fn(event, ...args);
    } catch {
      return { ok: false, error: "Operation failed" };
    }
  };
}

function requireAuthNoArgs(fn: IpcMainHandler): IpcMainHandler {
  return async (event: Electron.IpcMainInvokeEvent, token: string) => {
    if (!validateToken(token)) {
      return { ok: false, error: "Not authenticated" };
    }
    try {
      return await fn(event);
    } catch {
      return { ok: false, error: "Operation failed" };
    }
  };
}

const rateLimit: RateLimitState = {
  attempts: [],
  lockoutUntil: 0,
  MAX_ATTEMPTS: 5,
  WINDOW_MS: 15 * 60 * 1000,
  LOCKOUT_MS: 15 * 60 * 1000,
};

function isRateLimited(): boolean {
  const now = Date.now();
  if (now < rateLimit.lockoutUntil) return true;
  rateLimit.attempts = rateLimit.attempts.filter(
    (t) => now - t < rateLimit.WINDOW_MS,
  );
  if (rateLimit.attempts.length >= rateLimit.MAX_ATTEMPTS) {
    rateLimit.lockoutUntil = now + rateLimit.LOCKOUT_MS;
    return true;
  }
  return false;
}

function recordFailedAttempt(): void {
  const now = Date.now();
  rateLimit.attempts.push(now);
  if (rateLimit.attempts.length >= rateLimit.MAX_ATTEMPTS) {
    rateLimit.lockoutUntil = now + rateLimit.LOCKOUT_MS;
  }
}

function resetRateLimit(): void {
  rateLimit.attempts = [];
  rateLimit.lockoutUntil = 0;
}

export {
  SESSION_TOKEN_MAX_AGE,
  genSessionToken,
  validateToken,
  clearSession,
  setSession,
  getSession,
  requireAuth,
  requireAuthNoArgs,
  isRateLimited,
  recordFailedAttempt,
  resetRateLimit,
};
