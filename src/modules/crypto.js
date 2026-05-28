'use strict';

const crypto = require('crypto');

// CryptoJS reference — set by the main process after CryptoJS is loaded.
// Required only for legacy decryption of old-format ciphertexts.
let _CryptoJS = null;

/**
 * Set the CryptoJS library reference for legacy decryption fallback.
 * Must be called once during app startup before any legacy data is decrypted.
 * @param {object} lib — the CryptoJS library object
 */
function setCryptoJS(lib) {
  _CryptoJS = lib;
}

/**
 * Derive a 32-character hex key from a Google ID.
 * SHA-256 of "vault:" + googleId, truncated to 32 hex chars.
 * Must not be changed — all existing encrypted data uses this derivation.
 * @param {string} googleId
 * @returns {string} 32-character hex string
 */
function deriveKey(googleId) {
  return crypto.createHash('sha256').update('vault:' + googleId).digest('hex').slice(0, 32);
}

/**
 * Derive separate encryption and MAC keys from the 32-char hex key string.
 *   encKey = SHA-256(hexKey)  → 32 bytes raw AES key
 *   macKey = SHA-256(hexKey + "mac") → 32 bytes raw HMAC key
 * @param {string} hexKey
 * @returns {{ encKey: Buffer, macKey: Buffer }}
 */
function _keysFromHexKey(hexKey) {
  const encKey = crypto.createHash('sha256').update(hexKey).digest();
  const macKey = crypto.createHash('sha256').update(hexKey + 'mac').digest();
  return { encKey, macKey };
}

/**
 * Detect whether a ciphertext uses the new authenticated encryption format
 * or the old CryptoJS legacy format.
 * @param {string} ciphertext
 * @returns {boolean}
 */
function _isNewFormat(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return false;
  // Old CryptoJS format starts with "U2FsdGVk" (base64 of "Salted__")
  if (ciphertext.startsWith('U2FsdGVk')) return false;
  // New format: compact base64, minimum 48 raw bytes (32 MAC + 16 IV) → >= 64 base64 chars
  if (ciphertext.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(ciphertext)) {
    try {
      const decoded = Buffer.from(ciphertext, 'base64');
      return decoded.length >= 48;
    } catch { return false; }
  }
  return false;
}

/**
 * Encrypt an object with AES-256-CBC + HMAC-SHA256 (Encrypt-then-MAC).
 * Returns base64( HMAC(32 bytes) || IV(16 bytes) || Ciphertext ).
 * @param {object} obj — the value to encrypt (will be JSON.stringify'd)
 * @param {string} key — 32-character hex key (as returned by deriveKey)
 * @returns {string} base64-encoded ciphertext
 */
function enc(obj, key) {
  const { encKey, macKey } = _keysFromHexKey(key);
  const plaintext = JSON.stringify(obj);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(ct).digest();
  const packed = Buffer.concat([mac, iv, ct]);
  return packed.toString('base64');
}

/**
 * Decrypt a ciphertext string.
 * Handles both the new authenticated format (with HMAC verification) and
 * falls back to CryptoJS legacy decryption for old-format data.
 * @param {string} str — base64-encoded ciphertext
 * @param {string} key — 32-character hex key
 * @returns {object|null} the decrypted object, or null on failure
 */
function dec(str, key) {
  if (_isNewFormat(str)) {
    try {
      const { encKey, macKey } = _keysFromHexKey(key);
      const packed = Buffer.from(str, 'base64');
      if (packed.length < 64) return null;
      const mac = packed.subarray(0, 32);
      const iv = packed.subarray(32, 48);
      const ct = packed.subarray(48);
      const expectedMac = crypto.createHmac('sha256', macKey).update(iv).update(ct).digest();
      if (!crypto.timingSafeEqual(mac, expectedMac)) {
        return null;
      }
      const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return JSON.parse(pt.toString('utf8'));
    } catch {
      return null;
    }
  }
  // Fall back to legacy CryptoJS format for backward compatibility
  // NOTE: Legacy decryption has no HMAC authentication — migrate all data to new format
  if (!_CryptoJS) return null;
  try {
    return JSON.parse(_CryptoJS.AES.decrypt(str, key).toString(_CryptoJS.enc.Utf8));
  } catch { return null; }
}

module.exports = { deriveKey, enc, dec, setCryptoJS };
