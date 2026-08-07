// Canonical DDL: see server/sql/schema/03_memberships.sql
import { TABLES } from '../config/tables.js';

export function createMembershipsRepository({ bq, projectId }) {
  const table    = `\`${projectId}.${TABLES.MEMBERSHIPS}\``;
  const orgsTable = `\`${projectId}.${TABLES.ORGANIZATIONS}\``;
  const usersTable = `\`${projectId}.${TABLES.USERS}\``;

  // Every membership (active AND inactive) for a user. Used by the
  // admin user-edit flow to sync org assignments — we may need to
  // re-activate a previously-deactivated membership rather than
  // insert a duplicate row.
  async function findAllByUser(userId) {
    const query = `
      SELECT membership_id, user_id, organization_id, role, is_active, created_at
      FROM ${table}
      WHERE user_id = @userId
      ORDER BY created_at
    `;
    const [rows] = await bq.query({ query, params: { userId } });
    return rows;
  }

  // Mirror of findAllByUser, keyed by organization. Used by the
  // org-edit flow to sync the member roster.
  async function findAllByOrg(organizationId) {
    const query = `
      SELECT membership_id, user_id, organization_id, role, is_active, created_at
      FROM ${table}
      WHERE organization_id = @organizationId
      ORDER BY created_at
    `;
    const [rows] = await bq.query({ query, params: { organizationId } });
    return rows;
  }

  async function getUserMemberships(userId) {
    const query = `
      SELECT m.membership_id, m.user_id, m.organization_id, m.role, m.is_active, m.created_at,
             o.display_name AS org_display_name, o.slug AS org_slug
      FROM ${table} m
      JOIN ${orgsTable} o USING (organization_id)
      WHERE m.user_id       = @userId
        AND m.is_active     = TRUE
        AND o.is_active     = TRUE
      ORDER BY m.created_at
    `;
    const [rows] = await bq.query({ query, params: { userId } });
    return rows;
  }

  async function getMembershipById(membershipId) {
    const query = `
      SELECT membership_id, user_id, organization_id, role, is_active
      FROM ${table}
      WHERE membership_id = @membershipId
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { membershipId } });
    return rows[0] ?? null;
  }

  async function getMembership(userId, organizationId) {
    const query = `
      SELECT membership_id, user_id, organization_id, role, is_active
      FROM ${table}
      WHERE user_id         = @userId
        AND organization_id = @organizationId
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { userId, organizationId } });
    return rows[0] ?? null;
  }

  async function getMembersByOrg(organizationId) {
    const query = `
      SELECT m.membership_id, m.user_id, m.role, m.is_active, m.created_at,
             u.username, u.display_name
      FROM ${table} m
      JOIN ${usersTable} u USING (user_id)
      WHERE m.organization_id = @organizationId
      ORDER BY u.display_name
    `;
    const [rows] = await bq.query({ query, params: { organizationId } });
    return rows;
  }

  async function createMembership({ membership_id, user_id, organization_id, role }) {
    const query = `
      INSERT INTO ${table}
        (membership_id, user_id, organization_id, role, is_active, created_at)
      VALUES
        (@membership_id, @user_id, @organization_id, @role, TRUE, CURRENT_TIMESTAMP())
    `;
    await bq.query({ query, params: { membership_id, user_id, organization_id, role } });
  }

  async function updateMembership(membershipId, updates) {
    const allowed    = ['role', 'is_active'];
    const setClauses = Object.keys(updates)
      .filter(k => allowed.includes(k))
      .map(k => `${k} = @${k}`);
    if (!setClauses.length) return;
    const query = `
      UPDATE ${table}
      SET ${setClauses.join(', ')}
      WHERE membership_id = @membershipId
    `;
    await bq.query({ query, params: { ...updates, membershipId } });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Hard-delete cascades (2026-05-18). Called by the user/org permanent-
  // delete flow after the two-step gate (entity must already be
  // is_active=false). Irreversible.
  // ─────────────────────────────────────────────────────────────────────
  async function deleteAllByUserId(userId) {
    if (!userId) return 0;
    const query = `DELETE FROM ${table} WHERE user_id = @userId`;
    const [job] = await bq.query({ query, params: { userId } });
    return job?.numDmlAffectedRows ? Number(job.numDmlAffectedRows) : 0;
  }

  async function deleteAllByOrgId(organizationId) {
    if (!organizationId) return 0;
    const query = `DELETE FROM ${table} WHERE organization_id = @organizationId`;
    const [job] = await bq.query({ query, params: { organizationId } });
    return job?.numDmlAffectedRows ? Number(job.numDmlAffectedRows) : 0;
  }

  return {
    getUserMemberships, findAllByUser, findAllByOrg,
    getMembershipById, getMembership,
    getMembersByOrg, createMembership, updateMembership,
    deleteAllByUserId, deleteAllByOrgId,
  };
}
