import bcrypt from 'bcryptjs';
import { sha256, isBcryptHash } from '../utils/hash.js';
import { AppError } from '../utils/errors.js';

const BCRYPT_ROUNDS = 12;

// Usernames are globally unique across the platform.
// Organizations are resolved via the memberships table, never supplied by the caller.
export function createAuthService({ usersRepo, membershipsRepo }) {
  async function login(username, password) {
    const normalized = username.toLowerCase().trim();

    const user = await usersRepo.findByUsernameGlobal(normalized);
    if (!user) throw new AppError(401, 'Invalid credentials');

    const valid = await _verifyPassword(password, user.password_hash);
    if (!valid) throw new AppError(401, 'Invalid credentials');

    // Upgrade legacy SHA-256 hash to bcrypt on first successful login.
    if (!isBcryptHash(user.password_hash)) {
      const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
      usersRepo.updatePasswordHash(user.user_id, upgraded).catch(() => {});
    }

    const memberships = await membershipsRepo.getUserMemberships(user.user_id);
    if (!memberships.length) throw new AppError(401, 'No organization access configured');

    return {
      user_id:      user.user_id,
      username:     user.username,
      display_name: user.display_name,
      role:         user.role,           // global role from users.role (post Phase C)
      memberships,
    };
  }

  return { login };
}

async function _verifyPassword(plaintext, hash) {
  if (isBcryptHash(hash)) return bcrypt.compare(plaintext, hash);
  return sha256(plaintext) === hash;
}
