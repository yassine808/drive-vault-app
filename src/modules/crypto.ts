import crypto from 'crypto';

// CryptoJS type declaration for legacy decryption
declare global {
  // eslint-disable-next-line no-var
  var CryptoJS: {
    AES: {
      decrypt(ciphertext: string, key: string): { toString(encoder: { enc: { Utf8: string } }): string };
    };
    enc: { Utf8: string };
  };
}

let _CryptoJS: any = null;

function setCryptoJS(lib: typeof globalThis.CryptoJS): void {
  _CryptoJS = lib;
}

function deriveKey(googleId: string): string {
  return crypto.createHash('sha256').update('vault:' + googleId).digest('hex').slice(0, 32);
}

interface DerivedKeys {
  encKey: Buffer;
  macKey: Buffer;
}

function _keysFromHexKey(hexKey: string): DerivedKeys {
  const encKey = crypto.createHash('sha256').update(hexKey).digest();
  const macKey = crypto.createHash('sha256').update(hexKey + 'mac').digest();
  return { encKey, macKey };
}

function _isNewFormat(ciphertext: string): boolean {
  if (!ciphertext || typeof ciphertext !== 'string') return false;
  if (ciphertext.startsWith('U2FsdGVk')) return false;
  if (ciphertext.length >= 64 && /^[A-Za-z0-9+/=]+$/.test(ciphertext)) {
    try {
      const decoded = Buffer.from(ciphertext, 'base64');
      return decoded.length >= 48;
    } catch { return false; }
  }
  return false;
}

function enc(obj: object, key: string): string {
  const { encKey, macKey } = _keysFromHexKey(key);
  const plaintext = JSON.stringify(obj);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(ct).digest();
  const packed = Buffer.concat([mac, iv, ct]);
  return packed.toString('base64');
}

function dec(str: string, key: string): Record<string, unknown> | null {
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
  if (!_CryptoJS) return null;
  try {
    return JSON.parse(_CryptoJS.AES.decrypt(str, key).toString(_CryptoJS.enc.Utf8));
  } catch { return null; }
}

function derivePinKey(pin: string, salt: Buffer, iterations: number = 600000): string {
  return crypto.pbkdf2Sync(pin, salt, iterations, 32, 'sha256').toString('hex');
}

export { deriveKey, derivePinKey, enc, dec, setCryptoJS };
