import { TABLES } from '../config/tables.js';

// ============================================================
// dataRetentionService — per-org data wipe (uploads history retained)
// ------------------------------------------------------------
// SCOPED TO A SPECIFIC ORGANIZATION. Deletes the raw operational
// data + activity trail while KEEPING the upload audit rows so the
// Uploads tab still shows what was imported historically.
//
//   PRESERVED (never touched):
//     users              — account identity
//     organizations      — org identity
//     memberships        — user↔org linkage
//     refresh_tokens     — per-user, not per-org; skipped on org
//                          purge to avoid cross-org auth side effects
//     inventory_uploads  — upload audit history for the Uploads tab
//     order_uploads      — upload audit history for the Uploads tab
//
//   PURGED (all rows where organization_id = @org):
//     inventory          — raw inventory rows
//     orders             — raw order rows
//     activity_log       — user-action audit trail
//
// Every DELETE is scoped by organization_id — no other org's data
// can be touched. The route layer sources the org from the caller's
// JWT (request.user.organization_id), not from the request body,
// so the scope can't be spoofed.
// ============================================================

export function createDataRetentionService({ bq, projectId, logger }) {
  const inventory     = `\`${projectId}.${TABLES.INVENTORY}\``;
  const orders        = `\`${projectId}.${TABLES.ORDERS}\``;
  const activityLog   = `\`${projectId}.${TABLES.ACTIVITY_LOG}\``;
  // inventory_uploads + order_uploads intentionally NOT listed —
  // upload audit history is preserved so the Uploads tab still
  // shows past imports after a purge.

  function _isMissingTable(err) {
    const msg = String(err?.message ?? err ?? '');
    return /Not found: Table|does not have a table/i.test(msg);
  }

  async function _runDml(label, query, params = {}) {
    try {
      const [job] = await bq.query({ query, params });
      const affected = job?.numDmlAffectedRows ? Number(job.numDmlAffectedRows) : 0;
      return { label, ok: true, affected };
    } catch (err) {
      if (_isMissingTable(err)) {
        return { label, ok: true, affected: 0, skipped: 'table_missing' };
      }
      return { label, ok: false, error: err?.message ?? String(err) };
    }
  }

  // Purge ALL of one organization's operational data. The `days`
  // parameter is retained for API-compat but ignored. `organizationId`
  // is REQUIRED — passing empty falls through to a safety-net
  // rejection so no accidental all-orgs sweep can occur.
  async function purgeOldData(_daysIgnored = 0, organizationId = null) {
    if (!organizationId) {
      throw new Error('organizationId is required for retention purge');
    }
    const start = Date.now();
    const params = { organizationId };

    // Every DELETE is scoped by organization_id only. Runs in PARALLEL —
    // wall-clock is the slowest single DML.
    const results = await Promise.all([
      _runDml(
        'inventory',
        `DELETE FROM ${inventory} WHERE organization_id = @organizationId`,
        params,
      ),
      _runDml(
        'orders',
        `DELETE FROM ${orders} WHERE organization_id = @organizationId`,
        params,
      ),
      _runDml(
        'activity_log',
        `DELETE FROM ${activityLog} WHERE organization_id = @organizationId`,
        params,
      ),
    ]);

    const byLabel = Object.fromEntries(results.map(r => [r.label, r]));
    const anyFailed = results.some(r => !r.ok);
    const summary = {
      window_days:              0,   // no window — full wipe
      organization_id:          organizationId,
      duration_ms:              Date.now() - start,
      inventory_rows_deleted:   byLabel.inventory?.affected    ?? 0,
      orders_rows_deleted:      byLabel.orders?.affected       ?? 0,
      inv_uploads_deleted:      0,   // preserved — audit history
      ord_uploads_deleted:      0,   // preserved — audit history
      activity_rows_deleted:    byLabel.activity_log?.affected ?? 0,
      per_target:               byLabel,
      status:                   anyFailed ? 'partial' : 'success',
    };
    if (anyFailed) {
      logger?.warn?.({ err_targets: results.filter(r => !r.ok).map(r => r.label) }, 'Some DML sweeps failed');
    }
    return summary;
  }

  return { purgeOldData };
}
