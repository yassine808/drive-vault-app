import type { ItemType } from '../types';

const MAX_FIELD_LEN = 500;
const MAX_NOTES_LEN = 5000;
const VALID_ITEM_TYPES: readonly ItemType[] = ['password', 'note'];

function sanitizeStr(s: string | null | undefined, max: number = MAX_FIELD_LEN): string {
  if (s === null || s === undefined || typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

function validType(t: string): t is ItemType {
  return (VALID_ITEM_TYPES as readonly string[]).includes(t);
}

function validEmail(e: string): boolean {
  if (typeof e !== 'string') return false;
  return /^[a-zA-Z0-9._%+-]{1,128}@[a-zA-Z0-9.-]{1,256}.[a-zA-Z]{2,}$/.test(e.trim());
}

function validTotpSecret(s: string): boolean {
  return /^[A-Za-z2-7]{16,64}$/.test(String(s || '').replace(/s/g, ''));
}

function validDomain(d: string): boolean {
  if (typeof d !== 'string') return false;
  if (d.length > 253) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d);
}

export {
  MAX_FIELD_LEN,
  MAX_NOTES_LEN,
  VALID_ITEM_TYPES,
  sanitizeStr,
  validType,
  validEmail,
  validTotpSecret,
  validDomain,
};
