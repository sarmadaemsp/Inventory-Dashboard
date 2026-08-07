import { TABLES } from '../config/tables.js';

export function createUsersRepository({ bq, projectId }) {
  const table     = `\`${projectId}.${TABLES.USERS}\``;
  const mTable    = `\`${projectId}.${TABLES.MEMBERSHIPS}\``;
  const orgsTable = `\`${projectId}.${TABLES.ORGANIZATIONS}\``;

  // Global lookup — usernames are unique across the platform.
  async function findByUsernameGlobal(username) {
    const query = `
      SELECT user_id, username, password_hash, display_name, role, is_active
      FROM ${table}
      WHERE username  = @username
        AND is_active = TRUE
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { username } });
    return rows[0] ?? null;
  }

  async function findById(userId) {
    const query = `
      SELECT user_id, username, password_hash, display_name, role, is_active
      FROM ${table}
      WHERE user_id = @userId
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { userId } });
    return rows[0] ?? null;
  }

  async function findAll() {
    const query = `
      SELECT user_id, username, display_name, role, is_active, created_at
      FROM ${table}
      ORDER BY display_name
    `;
    const [rows] = await bq.query({ query });
    return rows;
  }

  // Global list used by the Settings → Users tab. Returns every user along
  // with their active memberships (org + role). Settings is admin-only and
  // org-neutral, so we never scope this to the caller's current workspace.
  //
  // Implementation note: BigQuery rejects correlated ARRAY subqueries that
  // reference an outer table column, so we pre-aggregate memberships into
  // a CTE keyed by user_id, then LEFT JOIN. Users with no active memberships
  // get a NULL memberships array (frontend treats NULL as empty).
  //
  // Each row:
  //   { user_id, username, display_name, is_active, created_at,
  //     memberships: [ { membership_id, organization_id, org_name, role } ] | null }
  async function findAllWithMemberships() {
    const query = `
      WITH user_memberships AS (
        SELECT
          m.user_id,
          ARRAY_AGG(
            STRUCT(m.membership_id, m.organization_id, m.role, o.display_name AS org_name)
            ORDER BY o.display_name
          ) AS memberships
        FROM ${mTable} m
        JOIN ${orgsTable} o USING (organization_id)
        WHERE m.is_active = TRUE
          AND o.is_active = TRUE
        GROUP BY m.user_id
      )
      SELECT
        u.user_id, u.username, u.display_name, u.role, u.is_active, u.created_at,
        um.memberships
      FROM ${table} u
      LEFT JOIN user_memberships um USING (user_id)
      ORDER BY u.display_name
    `;
    const [rows] = await bq.query({ query });
    return rows;
  }

  async function insert(user) {
    const query = `
      INSERT INTO ${table}
        (user_id, username, display_name, password_hash, is_active, created_at, updated_at)
      VALUES
        (@user_id, @username, @display_name, @password_hash,
         @is_active, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
    `;
    await bq.query({ query, params: user });
  }

  async function update(userId, updates) {
    const allowed    = ['display_name', 'is_active', 'role'];
    const setClauses = Object.keys(updates)
      .filter(k => allowed.includes(k))
      .map(k => `${k} = @${k}`);
    if (!setClauses.length) return;
    const query = `
      UPDATE ${table}
      SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP()
      WHERE user_id = @userId
    `;
    await bq.query({ query, params: { ...updates, userId } });
  }

  async function updatePasswordHash(userId, passwordHash) {
    const query = `
      UPDATE ${table}
      SET password_hash = @passwordHash, updated_at = CURRENT_TIMESTAMP()
      WHERE user_id = @userId
    `;
    await bq.query({ query, params: { passwordHash, userId } });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Hard-delete (2026-05-18). Irreversible row removal — the row is GONE,
  // not soft-flagged. Caller MUST verify the user is_active=false BEFORE
  // calling this; the two-step gate (deactivate → confirm → delete) is
  // enforced at the route layer so a single misclick can't destroy data.
  //
  // Membership rows and refresh-token rows for the same user are deleted
  // by their own repositories — this method only handles the users row.
  // ─────────────────────────────────────────────────────────────────────
  async function hardDeleteUser(userId) {
    if (!userId) return 0;
    const query = `DELETE FROM ${table} WHERE user_id = @userId`;
    const [job] = await bq.query({ query, params: { userId } });
    return job?.numDmlAffectedRows ? Number(job.numDmlAffectedRows) : 0;
  }

  return { findByUsernameGlobal, findById, findAll, findAllWithMemberships, insert, update, updatePasswordHash, hardDeleteUser };
}
