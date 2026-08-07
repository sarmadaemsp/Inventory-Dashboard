import { TABLES } from '../config/tables.js';

// ============================================================
// refreshTokensRepository — server-side refresh-token revocation
// ------------------------------------------------------------
// Closes audit gap C2 (was a stub before 2026-05-18). Every refresh
// token the platform mints is recorded here so /auth/refresh and
// /auth/logout can REJECT tokens that have been revoked, even if
// their JWT signature is still cryptographically valid.
//
// Lifecycle:
//   1. Login (or select-org)  → insert(...) with fresh jti + family_id.
//   2. /auth/refresh          → getActive(jti) to validate, then revoke
//                               the old jti and insert a new one in the
//                               same family.
//   3. /auth/logout           → revoke(jti) for the current refresh.
//   4. Password change        → revokeAllByUserId(userId) so every
//                               active device is logged out.
//   5. (Future) Logout-all    → revokeAllByUserId(userId).
//
// Notes:
//   - `getActive` returns null for: not-found, revoked, or expired.
//     The caller never needs to inspect timestamps directly.
//   - All writes are single-row DML — fast (<200ms typical) and the
//     volume is bounded by login/refresh frequency.
// ============================================================

// Detect "table doesn't exist" so the repo can degrade gracefully when
// the 20260518_002 migration hasn't been applied yet. Without this check
// every auth-issuing route (login, select-org, switch-org, refresh)
// would 500 on the missing-table INSERT. With it, auth stays functional
// in JWT-only "legacy" mode and the operator runs the migration at
// their pace.
function _isMissingTable(err) {
  const msg = String(err?.message ?? err ?? '');
  return /Not found: Table|does not have a table|no such table|table.+(?:does not exist|not found)/i.test(msg);
}

// Sentinel returned by getActive when the table is missing — distinct
// from `null` (token revoked / unknown). Lets the auth /refresh route
// drop into JWT-only degraded mode instead of rejecting the request.
export const FALLBACK_TABLE_MISSING = Object.freeze({ __fallback: 'table_missing' });

export function createRefreshTokensRepository({ bq, projectId, logger }) {
  const refreshTokensTable = `\`${projectId}.${TABLES.REFRESH_TOKENS}\``;

  // Latched once we've seen a missing-table error. Saves a query per
  // request after the first failure and prevents per-request log spam.
  // Reset to null on construction so a future re-deploy after the
  // migration re-probes naturally.
  let _missingTableLatched = false;

  function _markMissing(where) {
    if (!_missingTableLatched) {
      _missingTableLatched = true;
      logger?.warn?.(
        { event: 'refresh_tokens_table_missing', where },
        'refresh_tokens table missing — running auth in JWT-only legacy mode. Apply migration server/sql/migrations/20260518_002_refresh_token_revocation.sql to enable server-side revocation.',
      );
    }
  }

  // Public probe so callers / boot-log can surface the degraded state
  // without inferring it from query failures.
  function isLegacyMode() {
    return _missingTableLatched;
  }

  async function insert({ jti, userId, familyId, expiresAt, remembered, userAgent, ip }) {
    if (!jti || !userId || !familyId || !expiresAt) {
      throw new Error('refreshTokensRepository.insert: missing required field');
    }
    // Short-circuit when we've already detected the table is missing.
    // The caller can still mint the JWT and return success; the
    // revocation record simply isn't created until the migration runs.
    if (_missingTableLatched) return { persisted: false, fallback: true };

    const query = `
      INSERT INTO ${refreshTokensTable}
        (jti, user_id, family_id, expires_at, remembered, user_agent, ip)
      VALUES
        (@jti, @userId, @familyId, @expiresAt, @remembered, @userAgent, @ip)
    `;
    try {
      await bq.query({
        query,
        params: {
          jti, userId, familyId,
          expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
          remembered: !!remembered,
          userAgent: _truncate(userAgent, 256) ?? null,
          ip:        _truncate(ip,        64)  ?? null,
        },
        types: { userAgent: 'STRING', ip: 'STRING', expiresAt: 'TIMESTAMP' },
      });
      return { persisted: true, fallback: false };
    } catch (err) {
      if (_isMissingTable(err)) {
        _markMissing('insert');
        return { persisted: false, fallback: true };
      }
      throw err;
    }
  }

  // Returns:
  //   - row object             — token exists, not revoked, not expired
  //   - null                   — not found / revoked / expired (reject)
  //   - FALLBACK_TABLE_MISSING — table doesn't exist; caller should
  //                              drop into JWT-only degraded mode
  async function getActive(jti) {
    if (!jti) return null;
    if (_missingTableLatched) return FALLBACK_TABLE_MISSING;
    const query = `
      SELECT jti, user_id, family_id, expires_at, revoked_at, remembered, last_used_at
      FROM ${refreshTokensTable}
      WHERE jti = @jti
        AND revoked_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP()
      LIMIT 1
    `;
    try {
      const [rows] = await bq.query({ query, params: { jti } });
      const r = rows[0];
      if (!r) return null;
      return {
        jti:          r.jti,
        user_id:      r.user_id,
        family_id:    r.family_id,
        expires_at:   r.expires_at?.value   ?? r.expires_at,
        revoked_at:   r.revoked_at?.value   ?? r.revoked_at,
        remembered:   !!r.remembered,
        last_used_at: r.last_used_at?.value ?? r.last_used_at,
      };
    } catch (err) {
      if (_isMissingTable(err)) {
        _markMissing('getActive');
        return FALLBACK_TABLE_MISSING;
      }
      return null;
    }
  }

  // Idempotent revoke. Re-revoking a revoked token is a no-op
  // (WHERE revoked_at IS NULL won't match).
  async function revoke(jti) {
    if (!jti) return;
    const query = `
      UPDATE ${refreshTokensTable}
      SET revoked_at = CURRENT_TIMESTAMP()
      WHERE jti = @jti AND revoked_at IS NULL
    `;
    try { await bq.query({ query, params: { jti } }); }
    catch { /* non-fatal — the JWT is still expiring naturally */ }
  }

  // Revoke every active token in a rotation family. Wired but not
  // called yet — rotation-chain replay detection is a future
  // enhancement (deliberately deferred per Phase A design).
  async function revokeFamily(familyId) {
    if (!familyId) return;
    const query = `
      UPDATE ${refreshTokensTable}
      SET revoked_at = CURRENT_TIMESTAMP()
      WHERE family_id = @familyId AND revoked_at IS NULL
    `;
    try { await bq.query({ query, params: { familyId } }); }
    catch { /* non-fatal */ }
  }

  // Revoke every active token for a user. Called by:
  //   - password-change route (logs out every device)
  //   - future /auth/logout-all
  // Table is clustered by user_id so this only scans that user's rows.
  async function revokeAllByUserId(userId) {
    if (!userId) return 0;
    const query = `
      UPDATE ${refreshTokensTable}
      SET revoked_at = CURRENT_TIMESTAMP()
      WHERE user_id = @userId AND revoked_at IS NULL
    `;
    try {
      const [job] = await bq.query({ query, params: { userId } });
      return job?.numDmlAffectedRows ? Number(job.numDmlAffectedRows) : 0;
    } catch {
      return 0;
    }
  }

  // Hard-delete every refresh token for a user. Called by the user
  // permanent-delete flow — leaving "revoked" rows behind would
  // accumulate forever after a user is gone. Best-effort: tolerates
  // missing-table mode (legacy auth) by short-circuiting.
  async function deleteAllByUserId(userId) {
    if (!userId) return 0;
    if (_missingTableLatched) return 0;
    const query = `DELETE FROM ${refreshTokensTable} WHERE user_id = @userId`;
    try {
      const [job] = await bq.query({ query, params: { userId } });
      return job?.numDmlAffectedRows ? Number(job.numDmlAffectedRows) : 0;
    } catch (err) {
      if (_isMissingTable(err)) {
        _markMissing('deleteAllByUserId');
        return 0;
      }
      return 0;
    }
  }

  // Stamp last_used_at after a successful refresh. Used by future
  // "Active Sessions" UI; not load-bearing for security.
  async function markUsed(jti) {
    if (!jti) return;
    const query = `
      UPDATE ${refreshTokensTable}
      SET last_used_at = CURRENT_TIMESTAMP()
      WHERE jti = @jti
    `;
    try { await bq.query({ query, params: { jti } }); }
    catch { /* non-fatal */ }
  }

  return { insert, getActive, revoke, revokeFamily, revokeAllByUserId, deleteAllByUserId, markUsed, isLegacyMode };
}

function _truncate(s, n) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}
