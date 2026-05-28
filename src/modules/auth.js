'use strict';

const crypto = require('crypto');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SESSION_TOKEN_MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ysmagri@gmail.com';

// ─── INTERNAL STATE ───────────────────────────────────────────────────────────

let _sessionToken = null;
let _sessionTokenCreated = 0;
let _session = null;

// ─── SESSION TOKEN ────────────────────────────────────────────────────────────

/**
 * Generate a new 64-character hex session token.
 * Stores the token internally and records the creation timestamp.
 * @returns {string} the new session token
 */
function genSessionToken() {
  const t = crypto.randomBytes(32).toString('hex');
  _sessionToken = t;
  _sessionTokenCreated = Date.now();
  return t;
}

/**
 * Validate a session token against the internally stored token.
 * Uses constant-time comparison to prevent timing side-channels.
 * Enforces a 12-hour maximum token age.
 * @param {string} token — the token to validate
 * @returns {boolean}
 */
function validateToken(token) {
  if (!_sessionToken) return false;
  if (typeof token !== 'string' || token.length !== 64) return false;
  try {
    const a = Buffer.from(token, 'hex');
    const b = Buffer.from(_sessionToken, 'hex');
    if (a.length !== b.length) return false;
    if (!crypto.timingSafeEqual(a, b)) return false;
    if (Date.now() - _sessionTokenCreated > SESSION_TOKEN_MAX_AGE) {
      _sessionToken = null;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the stored session token and session object.
 * Called on logout or lock.
 */
function clearSession() {
  _sessionToken = null;
  _sessionTokenCreated = 0;
  _session = null;
}

/**
 * Store the current session object (user profile).
 * Used by requireAdminNoArgs to check admin email.
 * @param {object|null} session — the session object with an email property
 */
function setSession(session) {
  _session = session;
}

/**
 * Get the current session object.
 * @returns {object|null}
 */
function getSession() {
  return _session;
}

// ─── IPC AUTH WRAPPERS ───────────────────────────────────────────────────────

/**
 * Wrap an IPC handler with session-token validation.
 * The token must be the first argument passed by the renderer; it is consumed
 * and the remaining args are forwarded to the wrapped handler.
 * @param {function} fn — async handler expecting (event, ...args)
 * @returns {function} wrapped handler
 */
function requireAuth(fn) {
  return async (event, token, ...args) => {
    if (!validateToken(token)) {
      return { ok: false, error: 'Not authenticated' };
    }
    try {
      return await fn(event, ...args);
    } catch (e) {
      return { ok: false, error: 'Operation failed' };
    }
  };
}

/**
 * Wrap an IPC handler with session-token validation (no forwarded args).
 * @param {function} fn — async handler expecting (event)
 * @returns {function} wrapped handler
 */
function requireAuthNoArgs(fn) {
  return async (event, token) => {
    if (!validateToken(token)) {
      return { ok: false, error: 'Not authenticated' };
    }
    try {
      return await fn(event);
    } catch (e) {
      return { ok: false, error: 'Operation failed' };
    }
  };
}

/**
 * Wrap an IPC handler with session-token + admin email validation.
 * The session object must have been set via setSession() during login.
 * @param {function} fn — async handler expecting (event)
 * @returns {function} wrapped handler
 */
function requireAdminNoArgs(fn) {
  return async (event, token) => {
    if (!validateToken(token)) {
      return { ok: false, error: 'Not authenticated' };
    }
    if (!_session || _session.email !== ADMIN_EMAIL) {
      return { ok: false, error: 'Admin access required' };
    }
    try {
      return await fn(event);
    } catch (e) {
      return { ok: false, error: 'Operation failed' };
    }
  };
}

// ─── 2FA RATE LIMITER ─────────────────────────────────────────────────────────

const rateLimit = {
  attempts: [],
  lockoutUntil: 0,
  MAX_ATTEMPTS: 5,
  WINDOW_MS: 15 * 60 * 1000,
  LOCKOUT_MS: 15 * 60 * 1000,
};

/**
 * Check whether the 2FA rate limiter is currently blocking attempts.
 * Automatically expires old attempts outside the sliding window.
 * @returns {boolean} true if the caller should be blocked
 */
function isRateLimited() {
  const now = Date.now();
  if (now < rateLimit.lockoutUntil) return true;
  rateLimit.attempts = rateLimit.attempts.filter(t => now - t < rateLimit.WINDOW_MS);
  if (rateLimit.attempts.length >= rateLimit.MAX_ATTEMPTS) {
    rateLimit.lockoutUntil = now + rateLimit.LOCKOUT_MS;
    return true;
  }
  return false;
}

/**
 * Record a failed 2FA verification attempt.
 * Triggers lockout if the attempt count exceeds the maximum.
 */
function recordFailedAttempt() {
  const now = Date.now();
  rateLimit.attempts.push(now);
  if (rateLimit.attempts.length >= rateLimit.MAX_ATTEMPTS) {
    rateLimit.lockoutUntil = now + rateLimit.LOCKOUT_MS;
  }
}

/**
 * Reset the 2FA rate limiter (called on successful verification).
 */
function resetRateLimit() {
  rateLimit.attempts = [];
  rateLimit.lockoutUntil = 0;
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  SESSION_TOKEN_MAX_AGE,
  ADMIN_EMAIL,
  genSessionToken,
  validateToken,
  clearSession,
  setSession,
  getSession,
  requireAuth,
  requireAuthNoArgs,
  requireAdminNoArgs,
  isRateLimited,
  recordFailedAttempt,
  resetRateLimit,
};
