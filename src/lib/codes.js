import crypto from 'node:crypto';

// Crockford base32 (no I, L, O, U) — easy to read aloud if a label is damaged.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 12 chars = 60 bits of randomness; unguessable, and invalid guesses are rate-limited. */
export function randomCode(len = 12) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/** Accepts a raw code or any URL ending in /q/<code>; returns normalized code or null. */
export function extractCode(input) {
  if (!input) return null;
  let s = String(input).trim();
  const m = s.match(/\/q\/([0-9A-Za-z-]+)\/?(?:[?#].*)?$/);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/-/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{8,16}$/.test(s) ? s : null;
}

export const formatCode = (c) => c.match(/.{1,4}/g).join('-');

export const normalizeMobile = (m) => {
  const d = String(m || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  return d.length >= 10 && d.length <= 15 ? d : null; // allow international numbers
};

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
