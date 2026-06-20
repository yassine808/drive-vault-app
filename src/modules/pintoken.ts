/**
 * Shared PIN verify token store.
 * pin.ts generates tokens on successful verification.
 * main.ts consumes tokens in auth:loginWithPin.
 */

interface PinVerifyEntry {
  googleId: string;
  email: string;
  expiresAt: number;
}

const tokens = new Map<string, PinVerifyEntry>();

// Clean up expired tokens every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of tokens) {
    if (val.expiresAt < now) tokens.delete(key);
  }
}, 60_000);

export function storeToken(googleId: string, email: string): string {
  const token = require('crypto').randomBytes(16).toString('hex');
  tokens.set(token, { googleId, email, expiresAt: Date.now() + 30_000 });
  return token;
}

export function consumeToken(token: string): { googleId: string; email: string } | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  tokens.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return { googleId: entry.googleId, email: entry.email };
}
