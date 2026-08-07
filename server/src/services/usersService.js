import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { AppError } from '../utils/errors.js';

const BCRYPT_ROUNDS = 12;
const VALID_ROLES   = ['admin', 'manager', 'viewer'];

// `refreshTokensRepo` is optional so legacy callers / tests don't break,
// but it MUST be wired in production so password changes (and account
// deactivation) actually invalidate every active session. Without it,
// a leaked refresh token survives a password reset until natural expiry.
export function createUsersService({ usersRepo, membershipsRepo, usernameService, refreshTokensRepo }) {

  // Global list of every user with their active memberships.
  // Settings is admin-only and org-neutral — never scope to current workspace.
  async function list() {
    return usersRepo.findAllWithMemberships();
  }

  // Find global user by username — used by the "add existing user" flow.
  async function findByUsername(username) {
    const user = await usersRepo.findByUsernameGlobal(username);
    if (!user) return null;
    return {
      user_id:      user.user_id,
      username:     user.username,
      display_name: user.display_name,
      is_active:    user.is_active,
    };
  }

  // Create a new global user AND one or more memberships.
  //
  // Inputs:
  //   display_name      — required, shown in UI
  //   username          — required, globally unique; admin verified availability via /users/check-username
  //   password          — required, min 8 chars
  //   role              — required, one of VALID_ROLES (applied to every assigned org membership)
  //   organization_ids  — required, non-empty array of org UUIDs to assign membership in
  //
  // Settings is treated as outside any org context — the admin's "current
  // workspace" is irrelevant here. They explicitly choose the orgs for the
  // new user. No automatic injection.
  // eslint-disable-next-line no-unused-vars
  async function create(_creatingOrgId, { display_name, username, password, role, organization_ids }) {
    if (!display_name?.trim()) throw new AppError(400, 'display_name is required');
    if (!username?.trim())     throw new AppError(400, 'username is required');
    if (!password || password.length < 8) throw new AppError(400, 'Password must be at least 8 characters');
    if (!role || !VALID_ROLES.includes(role)) {
      throw new AppError(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
    }

    const orgIds = Array.isArray(organization_ids) ? [...new Set(organization_ids.filter(Boolean))] : [];
    if (!orgIds.length) throw new AppError(400, 'organization_ids must include at least one organization');

    const normalized = usernameService.normalize(username);
    if (!usernameService.isValid(normalized)) {
      throw new AppError(400, 'Username must be 2–32 characters, lowercase letters / numbers / underscores only');
    }
    if (!await usernameService.isAvailable(normalized)) {
      throw new AppError(409, `Username "${normalized}" is already taken`);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId       = randomUUID();

    await usersRepo.insert({
      user_id:       userId,
      username:      normalized,
      display_name:  display_name.trim(),
      password_hash: passwordHash,
      is_active:     true,
    });

    const memberships = [];
    for (const orgId of orgIds) {
      const membershipId = randomUUID();
      await membershipsRepo.createMembership({
        membership_id:   membershipId,
        user_id:         userId,
        organization_id: orgId,
        role,
      });
      memberships.push({ membership_id: membershipId, organization_id: orgId, role });
    }

    return { user_id: userId, username: normalized, display_name: display_name.trim(), role, memberships };
  }

  // Live username availability check used by the Add User form.
  // Returns { username, valid, available, suggestions }.
  // suggestions[] is populated only when the requested username is unavailable.
  async function checkUsername(username) {
    const normalized = usernameService.normalize(username || '');
    if (!usernameService.isValid(normalized)) {
      return { username: normalized, valid: false, available: false, suggestions: [] };
    }
    const available = await usernameService.isAvailable(normalized);
    if (available) return { username: normalized, valid: true, available: true, suggestions: [] };
    const suggestions = await usernameService.suggest(normalized, 5);
    return { username: normalized, valid: true, available: false, suggestions };
  }

  // Global user update (org-neutral, Settings context).
  // Accepted fields:
  //   display_name      — string, profile field on users
  //   password          — string ≥8 chars, rehashed
  //   is_active         — bool, deactivates platform-wide
  //   role              — admin/manager/viewer, global on users.role
  //   organization_ids  — non-empty array; memberships are synced to match
  //                       (deactivate orgs not in list, add/reactivate orgs in list)
  async function updateGlobalUser(userId, updates) {
    const user = await usersRepo.findById(userId);
    if (!user) throw new AppError(404, 'User not found');

    const profile = {};
    if (updates.display_name !== undefined) profile.display_name = updates.display_name.trim();
    if (updates.is_active    !== undefined) profile.is_active    = updates.is_active;
    if (updates.role         !== undefined) {
      if (!VALID_ROLES.includes(updates.role)) {
        throw new AppError(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
      }
      profile.role = updates.role;
    }
    if (Object.keys(profile).length) await usersRepo.update(userId, profile);

    if (updates.password !== undefined) {
      if (updates.password.length < 8) throw new AppError(400, 'Password must be at least 8 characters');
      const hash = await bcrypt.hash(updates.password, BCRYPT_ROUNDS);
      await usersRepo.updatePasswordHash(userId, hash);
      // Revoke every active refresh token for this user — any
      // session that was holding the old password's authentication
      // context is invalidated immediately. Frontend on next refresh
      // attempt gets 401 → forced re-login. Standard enterprise
      // behavior (Slack/GitHub/etc).
      await refreshTokensRepo?.revokeAllByUserId?.(userId);
    }

    // Account deactivation also invalidates all active sessions —
    // an inactive user shouldn't keep working in the app via a
    // pre-deactivation refresh token.
    if (updates.is_active === false) {
      await refreshTokensRepo?.revokeAllByUserId?.(userId);
    }

    if (updates.organization_ids !== undefined) {
      const target = [...new Set((updates.organization_ids || []).filter(Boolean))];
      if (!target.length) {
        throw new AppError(400, 'User must belong to at least one organization');
      }
      const effectiveRole = updates.role ?? user.role ?? 'viewer';
      await _syncMemberships(userId, target, effectiveRole);
    }
  }

  // Reconcile a user's active memberships with a target list of org_ids.
  // - Deactivate memberships not in target.
  // - Reactivate (and re-role) existing memberships in target.
  // - Create new memberships for orgs the user wasn't in before.
  async function _syncMemberships(userId, targetOrgIds, role) {
    const current = await membershipsRepo.findAllByUser(userId);
    const targetSet = new Set(targetOrgIds);
    const currentByOrg = new Map();
    for (const m of current) currentByOrg.set(m.organization_id, m);

    // Deactivate memberships not in target.
    for (const m of current) {
      if (m.is_active && !targetSet.has(m.organization_id)) {
        await membershipsRepo.updateMembership(m.membership_id, { is_active: false });
      }
    }

    // Add or reactivate memberships in target.
    for (const orgId of targetOrgIds) {
      const existing = currentByOrg.get(orgId);
      if (existing) {
        const patch = {};
        if (!existing.is_active)         patch.is_active = true;
        if (existing.role     !== role)  patch.role      = role; // mirror global role
        if (Object.keys(patch).length) {
          await membershipsRepo.updateMembership(existing.membership_id, patch);
        }
      } else {
        await membershipsRepo.createMembership({
          membership_id:   randomUUID(),
          user_id:         userId,
          organization_id: orgId,
          role,
        });
      }
    }
  }

  // Deactivate the user globally. All memberships become unreachable
  // because authentication checks users.is_active. The row is preserved
  // (no hard delete) so audit references in activity_log stay valid.
  async function deactivateUser(userId, requestingUserId) {
    if (userId === requestingUserId) throw new AppError(400, 'Cannot deactivate your own account');
    const user = await usersRepo.findById(userId);
    if (!user) throw new AppError(404, 'User not found');
    await usersRepo.update(userId, { is_active: false });
  }

  // Hard-delete the user — irreversible row removal from users +
  // every membership + every refresh token. Activity log entries are
  // intentionally LEFT in place so admin audit history isn't lost.
  //
  // Two-step gate: the user MUST already be is_active=false before
  // permanent delete is allowed. This prevents a single misclick from
  // destroying an active account. The gate is also enforced at the
  // route layer for defense in depth.
  async function permanentDeleteUser(userId, requestingUserId) {
    if (userId === requestingUserId) throw new AppError(400, 'Cannot permanently delete your own account');
    const user = await usersRepo.findById(userId);
    if (!user) throw new AppError(404, 'User not found');
    if (user.is_active !== false) {
      throw new AppError(409, 'User must be removed (deactivated) first. Open the Edit dialog, click Remove, then return to delete permanently.');
    }
    // Cascade memberships + refresh tokens in PARALLEL — no FK between
    // them, so wall-clock is the slower of the two (~1-2s) instead of
    // their sum. The users row deletes LAST so a partial cascade
    // failure leaves the user discoverable for retry.
    const [membershipsDeleted, tokensDeleted] = await Promise.all([
      membershipsRepo.deleteAllByUserId(userId),
      refreshTokensRepo?.deleteAllByUserId
        ? refreshTokensRepo.deleteAllByUserId(userId)
        : Promise.resolve(0),
    ]);
    const userDeleted = await usersRepo.hardDeleteUser(userId);
    return {
      user_deleted:        userDeleted,
      memberships_deleted: membershipsDeleted,
      tokens_deleted:      tokensDeleted,
      username:            user.username,
      display_name:        user.display_name,
    };
  }

  return { list, findByUsername, create, checkUsername, updateGlobalUser, deactivateUser, permanentDeleteUser };
}
