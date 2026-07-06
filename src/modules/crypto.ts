import crypto from "node:crypto";

// CryptoJS type declaration for legacy decryption
declare global {
  // eslint-disable-next-line no-var
  var CryptoJS: {
    AES: {
      decrypt(
        ciphertext: string,
        key: string,
      ): { toString(encoder: { enc: { Utf8: string } }): string };
    };
    enc: { Utf8: string };
  };
}

let _CryptoJS: typeof globalThis.CryptoJS | null = null;

function setCryptoJS(lib: typeof globalThis.CryptoJS): void {
  _CryptoJS = lib;
}

/**
 * Derive encryption key from googleId + optional per-account salt.
 *
 * Migration:
 *   - Old accounts (no salt): single SHA-256 hash — fast but weak.
 *   - New accounts (with salt): PBKDF2-SHA256, 600k iterations, 32-byte key.
 *   On first login after salt is introduced, the salt is generated, stored
 *   inside the encrypted user metadata (settings), and all data is
 *   re-encrypted lazily on next save. The deriveKey function detects
 *   the old format by checking whether a salt is available.
 */
const KEY_DERIVE_ITERATIONS = 600_000;

function deriveKey(googleId: string, userSaltHex?: string): string {
  if (userSaltHex) {
    // PBKDF2 path — strong
    const saltBuf = Buffer.from(userSaltHex, "hex");
    return crypto
      .pbkdf2Sync(googleId, saltBuf, KEY_DERIVE_ITERATIONS, 32, "sha256")
      .toString("hex");
  }
  // Legacy path — single SHA-256 (kept for backward compat during migration)
  return crypto
    .createHash("sha256")
    .update("vault:" + googleId)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Generate a new per-account salt (32 bytes hex). Call once per account.
 */
function generateUserSalt(): string {
  return crypto.randomBytes(32).toString("hex");
}

interface DerivedKeys {
  readonly encKey: Buffer;
  readonly macKey: Buffer;
}

function _keysFromHexKey(hexKey: string): DerivedKeys {
  const encKey = crypto.createHash("sha256").update(hexKey).digest();
  const macKey = crypto
    .createHash("sha256")
    .update(hexKey + "mac")
    .digest();
  return { encKey, macKey };
}

const NEW_FORMAT_BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function _isNewFormat(ciphertext: string): boolean {
  if (!ciphertext || typeof ciphertext !== "string") return false;
  if (ciphertext.startsWith("U2FsdGVk")) return false;
  if (ciphertext.length >= 64 && NEW_FORMAT_BASE64_RE.test(ciphertext)) {
    try {
      const decoded = Buffer.from(ciphertext, "base64");
      return decoded.length >= 48;
    } catch {
      return false;
    }
  }
  return false;
}

function enc(obj: object, key: string): string {
  const { encKey, macKey } = _keysFromHexKey(key);
  const plaintext = JSON.stringify(obj);
  const iv = crypto.randomBytes(16);
  // CBC here is paired with a separate HMAC-SHA256 over (iv || ciphertext) —
  // a standard encrypt-then-MAC construction, not raw unauthenticated CBC.
  // Switching to an AEAD mode (e.g. GCM) would require a full re-encryption
  // migration of all existing user vaults; not done here to avoid risking
  // data loss. NOSONAR
  const cipher = crypto.createCipheriv("aes-256-cbc", encKey, iv); // NOSONAR
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const mac = crypto.createHmac("sha256", macKey).update(iv).update(ct).digest();
  const packed = Buffer.concat([mac, iv, ct]);
  return packed.toString("base64");
}

function _decryptNewFormat(
  str: string,
  encKey: Buffer,
  macKey: Buffer,
): Record<string, unknown> | null {
  const packed = Buffer.from(str, "base64");
  if (packed.length < 64) return null;
  const mac = packed.subarray(0, 32);
  const iv = packed.subarray(32, 48);
  const ct = packed.subarray(48);
  const expectedMac = crypto.createHmac("sha256", macKey).update(iv).update(ct).digest();
  if (!crypto.timingSafeEqual(mac, expectedMac)) {
    return null;
  }
  const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

function _decryptLegacy(str: string, key: string): Record<string, unknown> | null {
  if (!_CryptoJS) return null;
  return JSON.parse(_CryptoJS.AES.decrypt(str, key).toString(_CryptoJS.enc.Utf8 as any));
}

function dec(str: string, key: string): Record<string, unknown> | null {
  if (_isNewFormat(str)) {
    try {
      const { encKey, macKey } = _keysFromHexKey(key);
      return _decryptNewFormat(str, encKey, macKey);
    } catch {
      return null;
    }
  }
  try {
    return _decryptLegacy(str, key);
  } catch {
    return null;
  }
}

/**
 * Decrypt with automatic fallback: tries the PBKDF2 key first, then falls
 * back to the legacy SHA-256 key. This allows reading data that was
 * encrypted before per-account salts were introduced.
 */
function decWithFallback(
  str: string,
  googleId: string,
  userSaltHex?: string,
): Record<string, unknown> | null {
  // Try strong key first (PBKDF2 with salt)
  if (userSaltHex) {
    const strongKey = deriveKey(googleId, userSaltHex);
    const result = dec(str, strongKey);
    if (result) return result;
  }
  // Fallback: legacy SHA-256 key (no salt)
  const legacyKey = deriveKey(googleId);
  return dec(str, legacyKey);
}

function derivePinKey(pin: string, salt: Buffer, iterations: number = 600000): string {
  return crypto.pbkdf2Sync(pin, salt, iterations, 32, "sha256").toString("hex");
}

export { deriveKey, generateUserSalt, derivePinKey, enc, dec, decWithFallback, setCryptoJS };
