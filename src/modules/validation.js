'use strict';

const MAX_FIELD_LEN = 500;
const MAX_NOTES_LEN = 5000;
const VALID_ITEM_TYPES = ['password', 'note'];

function sanitizeStr(s, max = MAX_FIELD_LEN) {
  return String(s || '').trim().slice(0, max);
}

function validType(t) {
  return VALID_ITEM_TYPES.includes(t);
}

function validEmail(e) {
  return /^[^\s@]{1,128}@[^\s@]{1,256}\.[^\s@]{2,}$/.test(String(e || ''));
}

function validTotpSecret(s) {
  return /^[A-Z2-7]{16,64}$/.test(String(s || '').replace(/\s/g, ''));
}

function validDomain(d) {
  if (typeof d !== 'string') return false;
  if (d.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d);
}

module.exports = {
  MAX_FIELD_LEN,
  MAX_NOTES_LEN,
  VALID_ITEM_TYPES,
  sanitizeStr,
  validType,
  validEmail,
  validTotpSecret,
  validDomain,
};
