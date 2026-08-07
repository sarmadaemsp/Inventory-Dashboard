import { randomUUID } from 'crypto';
import { TABLES } from '../config/tables.js';

export function createActivityRepository({ bq, projectId }) {
  const table = `\`${projectId}.${TABLES.ACTIVITY_LOG}\``;

  const ICONS = {
    upload_inventory:  '📦',
    upload_orders:     '🛒',
    delete_inventory:  '🗑',
    delete_orders:     '🗑',
    edit_inventory:    '✏️',
    edit_order:        '✏️',
  };

  // Append a row to activity_log. Switched from streaming-insert to
  // DML INSERT in M4 (2026-05-18) because:
  //   1. Streaming inserts lock rows from UPDATE/DELETE for ~90 min
  //      via BQ's streaming buffer. Even though we never DELETE
  //      activity_log rows (audit retention), streaming has higher
  //      per-row cost and looser consistency.
  //   2. DML INSERT places the row in regular storage immediately —
  //      visible to next-millisecond SELECTs and immutable from
  //      buffer-related quirks.
  //
  // Failures stay non-fatal: an audit-log write must never block the
  // originating user action.
  async function log({ organizationId, userId, actionType, entityType, description }) {
    const query = `
      INSERT INTO ${table}
        (activity_id, organization_id, user_id, action_type, entity_type, description, created_at)
      VALUES
        (@activity_id, @organization_id, @user_id, @action_type, @entity_type, @description, CURRENT_TIMESTAMP())
    `;
    try {
      await bq.query({
        query,
        params: {
          activity_id:     randomUUID(),
          organization_id: organizationId,
          user_id:         userId || null,
          action_type:     actionType,
          entity_type:     entityType,
          description,
        },
        types: { user_id: 'STRING' },
      });
    } catch { /* non-fatal — activity log failures must not break main operations */ }
  }

  async function getRecent(organizationId, limit = 10) {
    const safe = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
    const query = `
      SELECT activity_id, user_id, action_type, entity_type, description, created_at
      FROM ${table}
      WHERE organization_id = @organizationId
      ORDER BY created_at DESC
      LIMIT ${safe}
    `;
    try {
      const [rows] = await bq.query({ query, params: { organizationId } });
      return rows.map(r => ({
        id:          r.activity_id,
        icon:        ICONS[r.action_type] || '📄',
        title:       r.description,
        action_type: r.action_type,
        entity_type: r.entity_type,
        date:        r.created_at?.value ?? r.created_at ?? null,
      }));
    } catch {
      return [];
    }
  }

  return { log, getRecent };
}
