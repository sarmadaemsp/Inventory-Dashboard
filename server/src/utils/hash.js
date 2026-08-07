import { createHash } from 'crypto';

// Legacy Apps Script passwords are SHA-256 hex (64 chars).
// New passwords use bcrypt ($2b$ prefix).

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function isBcryptHash(hash) {
  return typeof hash === 'string' && (hash.startsWith('$2b$') || hash.startsWith('$2a$'));
}
