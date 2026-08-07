import { randomUUID } from 'crypto';
import { env } from '../config/env.js';

// Parse a JWT-style duration ("15m", "2h", "7d", "30d") into milliseconds.
// Used to derive the `expires_at` for the refresh_tokens table row from
// the same TTL string we hand to fastify-jwt — keeps the JWT exp claim
// and the DB row exactly aligned.
function _expiresInMs(ttl) {
  const m = /^(\d+)([smhd])$/i.exec(String(ttl).trim());
  if (!m) throw new Error(`Invalid JWT expiry format: ${ttl}`);
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default:  throw new Error(`Invalid JWT expiry unit: ${m[2]}`);
  }
}

export function createTokenFactory(fastify) {
  return {
    // Access token is always scoped to a specific membership.
    signAccessToken(membership) {
      return fastify.jwt.sign(
        {
          user_id:          membership.user_id,
          organization_id:  membership.organization_id,
          membership_id:    membership.membership_id,
          username:         membership.username,
          display_name:     membership.display_name,
          role:             membership.role,
          org_display_name: membership.org_display_name || '',
          org_slug:         membership.org_slug         || '',
          type:             'access',
        },
        { expiresIn: env.JWT_ACCESS_EXPIRES }
      );
    },

    // Refresh token. Carries user identity + a JTI + a family_id (for
    // rotation chains). `remembered` chooses the longer TTL.
    //
    // When jti/familyId are supplied (rotation path) the existing
    // family_id is preserved so the rotation chain stays intact. At
    // initial login the caller omits them and we mint new ones.
    //
    // Returns BOTH the signed token AND the metadata the caller needs
    // to persist a row in refresh_tokens. The two MUST be inserted as
    // a pair — the JWT alone is unenforceable without the DB row.
    signRefreshToken({ userId, remembered = false, jti = null, familyId = null }) {
      const ttl       = remembered ? env.JWT_REFRESH_EXPIRES_REMEMBERED : env.JWT_REFRESH_EXPIRES;
      const newJti    = jti       || randomUUID();
      const newFamily = familyId  || randomUUID();
      const expiresAt = new Date(Date.now() + _expiresInMs(ttl));

      const token = fastify.jwt.sign(
        {
          user_id:    userId,
          type:       'refresh',
          jti:        newJti,
          family_id:  newFamily,
          remembered: !!remembered,
        },
        { expiresIn: ttl }
      );

      return {
        token,
        jti:        newJti,
        family_id:  newFamily,
        expires_at: expiresAt,
        remembered: !!remembered,
      };
    },

    // Short-lived token issued after password check when user has
    // multiple orgs. Only grants access to /auth/select-org.
    // Carries the user's `remember` preference forward so the
    // eventual access+refresh pair issued from select-org honors it.
    signPendingToken(user, { remembered = false } = {}) {
      return fastify.jwt.sign(
        {
          user_id:      user.user_id,
          username:     user.username,
          display_name: user.display_name,
          remembered:   !!remembered,
          type:         'pending',
        },
        { expiresIn: '5m' }
      );
    },
  };
}
