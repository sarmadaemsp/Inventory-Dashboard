import { TABLES } from '../config/tables.js';
import { effectiveSkuSql, wrongPartSql } from '../utils/skuPatterns.js';
import { ordersAggCTE, invAggCTE, perSkuCTE } from '../utils/skuPivots.js';

/**
 * summaryRefreshService — rebuilds the four materialized summary tables
 * for a single organization. The ONLY way these tables are updated.
 *
 * Atomic refresh model (MERGE):
 *   Each rebuild runs as a single MERGE statement scoped to one org.
 *   - WHEN MATCHED: update existing row with fresh aggregates
 *   - WHEN NOT MATCHED BY TARGET: insert new row
 *   - WHEN NOT MATCHED BY SOURCE AND T.org = @x: delete stale rows
 *
 * Why MERGE instead of DELETE+INSERT:
 *   - DELETE+INSERT had a duplicate-row hazard under concurrent refreshes
 *     on the same org. Two overlapping refreshes could each DELETE
 *     (second is no-op) then both INSERT → duplicate rows.
 *   - DELETE+INSERT also left a brief empty-rows window between the two
 *     statements during which a reader saw zero rows for that org.
 *   - MERGE is atomic from a reader's perspective and idempotent under
 *     concurrent execution: two overlapping merges produce the same
 *     correct final state.
 *
 * The `WHEN NOT MATCHED BY SOURCE AND T.organization_id = @organizationId`
 * clause is CRITICAL — it scopes the delete to one org's rows so the
 * merge can never touch another org's data.
 *
 * Process-local refresh coalescing:
 *   Mutations on the same org within a 500ms window collapse into a
 *   single trailing refresh. First call fires immediately (leading edge);
 *   subsequent calls inside the cooldown are debounced. Burst protection
 *   for bulk uploads or rapid sequential edits — see refresh() below.
 *
 * Refresh failures are non-fatal. The caller wraps in try/catch + log;
 * the originating operation (upload, edit, etc.) still commits. The
 * KPI parity logger and the next refresh will catch the drift.
 */
export function createSummaryRefreshService({ bq, projectId, orgsRepo, logger }) {
  const invTable          = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable          = `\`${projectId}.${TABLES.ORDERS}\``;
  const dashboardSummary  = `\`${projectId}.${TABLES.DASHBOARD_SUMMARY}\``;
  const inventorySummary  = `\`${projectId}.${TABLES.INVENTORY_SUMMARY}\``;
  const boxSummaryByUpc   = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_UPC}\``;
  const boxSummaryByPart  = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_PART}\``;

  async function _resolveSkuRegex(organizationId) {
    if (!orgsRepo?.getSkuRegex) return null;
    try { return await orgsRepo.getSkuRegex(organizationId); }
    catch { return null; }
  }

  function _bindings(organizationId, skuRegex) {
    const params = { organizationId };
    let regexParam = null;
    if (skuRegex) {
      params.sku_regex = skuRegex;
      regexParam = 'sku_regex';
    }
    return { params, regexParam };
  }

  // CTE builders imported from utils/skuPivots.js — single source of truth
  // shared with inventoryMetricsService. Live computation and materialized
  // rebuild cannot drift because they're literally the same SQL text.
  const _ordersAggCTE  = ()           => ordersAggCTE({ ordTable });
  const _invAggCTE     = (regexParam) => invAggCTE({ invTable, regexParam });
  const _perSkuCTE     = ()           => perSkuCTE();

  // Structured per-table logging. Captures table, duration, status, and
  // optional error message. Useful for incident debugging — operators
  // can filter Cloud Logging by event=summary_refresh_table to see which
  // table broke and how long it took.
  function _emitTableLog({ organizationId, table, durationMs, status, err }) {
    const fields = {
      event:           'summary_refresh_table',
      organization_id: organizationId,
      table,
      duration_ms:     durationMs,
      status,
    };
    if (err) fields.err = err.message || String(err);
    if (status === 'ok') logger?.info?.(fields,  `${table} rebuilt`);
    else                 logger?.warn?.(fields, `${table} rebuild failed`);
  }

  async function _runTable(name, organizationId, fn) {
    const start = Date.now();
    try {
      await fn();
      _emitTableLog({ organizationId, table: name, durationMs: Date.now() - start, status: 'ok' });
      return { ok: true };
    } catch (err) {
      _emitTableLog({ organizationId, table: name, durationMs: Date.now() - start, status: 'failed', err });
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // dashboard_summary — one row per org. Simple MERGE (no NOT MATCHED
  // BY SOURCE needed because we never need to delete per-org rows here;
  // a single row replaces itself in place).
  // ─────────────────────────────────────────────────────────────────────
  async function _rebuildDashboardSummary(organizationId, skuRegex) {
    const { params, regexParam } = _bindings(organizationId, skuRegex);
    const query = `
      MERGE INTO ${dashboardSummary} T
      USING (
        WITH ${_ordersAggCTE()},
        ${_invAggCTE(regexParam)},
        ${_perSkuCTE()},
        inv_skus_for_join AS (
          SELECT DISTINCT sku FROM ${invTable} WHERE organization_id = @organizationId
        ),
        o_eff AS (
          SELECT
            o.*,
            ${effectiveSkuSql({ skuCol: 'o.sku', shippedCol: 'o.shipped_sku' })} AS effective_sku
          FROM ${ordTable} o
          WHERE o.organization_id = @organizationId
        ),
        inv_pivot AS (
          SELECT
            COUNT(*)                       AS total_skus,
            SUM(initial)                   AS total_units,
            SUM(fulfilled)                 AS fulfilled_units,
            SUM(phantom)                   AS phantom_units,
            SUM(remaining)                 AS physical_remaining_units,
            COUNTIF(remaining > 0)         AS in_stock_skus,
            COUNTIF(remaining = 0)         AS oos_skus,
            COUNTIF(phantom > 0)           AS phantom_skus,
            COUNTIF(is_undefined)          AS undefined_skus
          FROM per_sku
        ),
        ord_pivot AS (
          SELECT
            COUNT(*)                                                            AS total_orders,
            SUM(o.quantity_sold)                                                AS units_sold_raw,
            SUM(IF(${wrongPartSql({ skuCol: 'o.sku', shippedCol: 'o.shipped_sku' })}, o.quantity_sold, 0)) AS wrong_part_units,
            COUNTIF(inv.sku IS NULL)                                            AS unknown_orders,
            SUM(IF(inv.sku IS NULL, o.quantity_sold, 0))                        AS unknown_units_sold,
            COUNT(DISTINCT CASE WHEN o.platform IS NOT NULL THEN o.platform END) AS active_platforms
          FROM o_eff o
          LEFT JOIN inv_skus_for_join inv ON COALESCE(o.mapped_inventory_sku, o.effective_sku) = inv.sku
        )
        SELECT
          @organizationId AS organization_id,
          inv_pivot.total_skus,
          inv_pivot.total_units,
          inv_pivot.fulfilled_units,
          inv_pivot.phantom_units,
          inv_pivot.physical_remaining_units,
          inv_pivot.in_stock_skus,
          inv_pivot.oos_skus,
          inv_pivot.phantom_skus,
          inv_pivot.undefined_skus,
          ord_pivot.units_sold_raw,
          ord_pivot.unknown_units_sold,
          ord_pivot.unknown_orders,
          ord_pivot.wrong_part_units,
          ord_pivot.total_orders,
          ord_pivot.active_platforms
        FROM inv_pivot, ord_pivot
      ) S
      ON T.organization_id = S.organization_id
      WHEN MATCHED THEN UPDATE SET
        total_skus               = S.total_skus,
        total_units              = S.total_units,
        fulfilled_units          = S.fulfilled_units,
        phantom_units            = S.phantom_units,
        physical_remaining_units = S.physical_remaining_units,
        in_stock_skus            = S.in_stock_skus,
        oos_skus                 = S.oos_skus,
        phantom_skus             = S.phantom_skus,
        undefined_skus           = S.undefined_skus,
        units_sold_raw           = S.units_sold_raw,
        unknown_units_sold       = S.unknown_units_sold,
        unknown_orders           = S.unknown_orders,
        wrong_part_units         = S.wrong_part_units,
        total_orders             = S.total_orders,
        active_platforms         = S.active_platforms,
        refreshed_at             = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED BY TARGET THEN
        INSERT (
          organization_id, total_skus, total_units, fulfilled_units,
          phantom_units, physical_remaining_units, in_stock_skus, oos_skus,
          phantom_skus, undefined_skus, units_sold_raw, unknown_units_sold,
          unknown_orders, wrong_part_units, total_orders, active_platforms,
          refreshed_at
        )
        VALUES (
          S.organization_id, S.total_skus, S.total_units, S.fulfilled_units,
          S.phantom_units, S.physical_remaining_units, S.in_stock_skus, S.oos_skus,
          S.phantom_skus, S.undefined_skus, S.units_sold_raw, S.unknown_units_sold,
          S.unknown_orders, S.wrong_part_units, S.total_orders, S.active_platforms,
          CURRENT_TIMESTAMP()
        )
    `;
    await bq.query({ query, params });
  }

  // ─────────────────────────────────────────────────────────────────────
  // inventory_summary — one row per (organization_id, sku).
  // Full MERGE with WHEN NOT MATCHED BY SOURCE to drop SKUs that no
  // longer exist in raw inventory (e.g. operator removed all rows for
  // a SKU).
  // ─────────────────────────────────────────────────────────────────────
  async function _rebuildInventorySummary(organizationId, skuRegex) {
    const { params, regexParam } = _bindings(organizationId, skuRegex);
    const query = `
      MERGE INTO ${inventorySummary} T
      USING (
        WITH ${_ordersAggCTE()},
        ${_invAggCTE(regexParam)},
        ${_perSkuCTE()},
        extras AS (
          SELECT
            sku,
            COUNT(DISTINCT box_number)        AS boxes_count,
            MAX(date_added)                   AS last_added_at,
            ANY_VALUE(part_number)            AS part_number,
            ANY_VALUE(upc)                    AS upc
          FROM ${invTable}
          WHERE organization_id = @organizationId
          GROUP BY sku
        )
        SELECT
          @organizationId      AS organization_id,
          per_sku.sku          AS sku,
          per_sku.initial      AS total_stock,
          per_sku.sold         AS sold_units,
          per_sku.fulfilled    AS fulfilled_units,
          per_sku.phantom      AS phantom_units,
          per_sku.remaining    AS remaining_units,
          extras.boxes_count   AS boxes_count,
          extras.last_added_at AS last_added_at,
          extras.part_number   AS part_number,
          extras.upc           AS upc,
          per_sku.is_undefined AS is_undefined
        FROM per_sku
        LEFT JOIN extras ON per_sku.sku = extras.sku
      ) S
      ON T.organization_id = S.organization_id AND T.sku = S.sku
      WHEN MATCHED THEN UPDATE SET
        total_stock     = S.total_stock,
        sold_units      = S.sold_units,
        fulfilled_units = S.fulfilled_units,
        phantom_units   = S.phantom_units,
        remaining_units = S.remaining_units,
        boxes_count     = S.boxes_count,
        last_added_at   = S.last_added_at,
        part_number     = S.part_number,
        upc             = S.upc,
        is_undefined    = S.is_undefined,
        refreshed_at    = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED BY TARGET THEN
        INSERT (
          organization_id, sku, total_stock, sold_units, fulfilled_units,
          phantom_units, remaining_units, boxes_count, last_added_at,
          part_number, upc, is_undefined, refreshed_at
        )
        VALUES (
          S.organization_id, S.sku, S.total_stock, S.sold_units, S.fulfilled_units,
          S.phantom_units, S.remaining_units, S.boxes_count, S.last_added_at,
          S.part_number, S.upc, S.is_undefined, CURRENT_TIMESTAMP()
        )
      WHEN NOT MATCHED BY SOURCE AND T.organization_id = @organizationId THEN DELETE
    `;
    await bq.query({ query, params });
  }

  // ─────────────────────────────────────────────────────────────────────
  // box_summary_by_upc / box_summary_by_part — atomic MERGE per table.
  // Same source CTE chain feeds both. The two MERGEs run sequentially
  // (BQ doesn't support multi-table MERGE) but each is internally atomic.
  // ─────────────────────────────────────────────────────────────────────
  async function _rebuildBoxSummary(organizationId) {
    // Shared source — the canonical box-grain pivot used to feed both
    // _by_upc and _by_part. The two MERGE statements just re-key the
    // same data on different cluster columns.
    const sourceCTEs = `
      WITH inv_grouped AS (
        SELECT
          COALESCE(upc, '')         AS upc,
          COALESCE(part_number, '') AS part_number,
          COALESCE(box_number, '')  AS box_number,
          SUM(quantity)             AS initial_stock
        FROM ${invTable}
        WHERE organization_id = @organizationId
        GROUP BY COALESCE(box_number, ''), COALESCE(part_number, ''), COALESCE(upc, '')
      ),
      inv_skus AS (
        SELECT DISTINCT
          COALESCE(upc, '')         AS upc,
          COALESCE(part_number, '') AS part_number,
          COALESCE(box_number, '')  AS box_number,
          sku
        FROM ${invTable}
        WHERE organization_id = @organizationId
      ),
      ${_ordersAggCTE()},
      box_orders AS (
        SELECT
          s.upc, s.part_number, s.box_number,
          COALESCE(SUM(o.ordered), 0) AS units_sold
        FROM inv_skus s
        LEFT JOIN orders_agg o ON s.sku = o.effective_sku
        GROUP BY s.upc, s.part_number, s.box_number
      ),
      box_rows AS (
        SELECT
          ig.upc,
          ig.part_number,
          ig.box_number,
          ig.initial_stock,
          LEAST(COALESCE(bo.units_sold, 0), ig.initial_stock)        AS fulfilled_units,
          GREATEST(COALESCE(bo.units_sold, 0) - ig.initial_stock, 0) AS phantom_units,
          GREATEST(ig.initial_stock - COALESCE(bo.units_sold, 0), 0) AS remaining_stock
        FROM inv_grouped ig
        LEFT JOIN box_orders bo
          ON  ig.box_number  = bo.box_number
          AND ig.part_number = bo.part_number
          AND ig.upc         = bo.upc
      )
    `;

    // ── box_summary_by_upc ── MERGE on (org, upc, part, box)
    const byUpcQuery = `
      MERGE INTO ${boxSummaryByUpc} T
      USING (
        ${sourceCTEs}
        SELECT
          @organizationId          AS organization_id,
          LOWER(TRIM(upc))         AS upc_norm,
          upc, part_number, box_number,
          initial_stock, fulfilled_units, phantom_units, remaining_stock
        FROM box_rows
      ) S
      ON  T.organization_id = S.organization_id
      AND T.upc             = S.upc
      AND T.part_number     = S.part_number
      AND T.box_number      = S.box_number
      WHEN MATCHED THEN UPDATE SET
        upc_norm        = S.upc_norm,
        initial_stock   = S.initial_stock,
        fulfilled_units = S.fulfilled_units,
        phantom_units   = S.phantom_units,
        remaining_stock = S.remaining_stock,
        refreshed_at    = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED BY TARGET THEN
        INSERT (
          organization_id, upc_norm, upc, part_number, box_number,
          initial_stock, fulfilled_units, phantom_units, remaining_stock,
          refreshed_at
        )
        VALUES (
          S.organization_id, S.upc_norm, S.upc, S.part_number, S.box_number,
          S.initial_stock, S.fulfilled_units, S.phantom_units, S.remaining_stock,
          CURRENT_TIMESTAMP()
        )
      WHEN NOT MATCHED BY SOURCE AND T.organization_id = @organizationId THEN DELETE
    `;
    await bq.query({ query: byUpcQuery, params: { organizationId } });

    // ── box_summary_by_part ── MERGE on (org, upc, part, box)
    const byPartQuery = `
      MERGE INTO ${boxSummaryByPart} T
      USING (
        ${sourceCTEs}
        SELECT
          @organizationId          AS organization_id,
          LOWER(TRIM(part_number)) AS part_norm,
          upc, part_number, box_number,
          initial_stock, fulfilled_units, phantom_units, remaining_stock
        FROM box_rows
      ) S
      ON  T.organization_id = S.organization_id
      AND T.upc             = S.upc
      AND T.part_number     = S.part_number
      AND T.box_number      = S.box_number
      WHEN MATCHED THEN UPDATE SET
        part_norm       = S.part_norm,
        initial_stock   = S.initial_stock,
        fulfilled_units = S.fulfilled_units,
        phantom_units   = S.phantom_units,
        remaining_stock = S.remaining_stock,
        refreshed_at    = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED BY TARGET THEN
        INSERT (
          organization_id, part_norm, upc, part_number, box_number,
          initial_stock, fulfilled_units, phantom_units, remaining_stock,
          refreshed_at
        )
        VALUES (
          S.organization_id, S.part_norm, S.upc, S.part_number, S.box_number,
          S.initial_stock, S.fulfilled_units, S.phantom_units, S.remaining_stock,
          CURRENT_TIMESTAMP()
        )
      WHEN NOT MATCHED BY SOURCE AND T.organization_id = @organizationId THEN DELETE
    `;
    await bq.query({ query: byPartQuery, params: { organizationId } });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Process-local refresh coalescing.
  // Leading edge + trailing debounce: first call fires immediately;
  // subsequent calls within the cooldown window are collapsed into one
  // trailing call at the end of the window. A burst of N mutations on
  // the same org thus produces at most 2 actual refreshes (one early,
  // one final), not N.
  //
  // This is process-local — across multiple Cloud Run instances the
  // coalescing degrades to per-instance, which is still a 90%+ win
  // because a single client's burst typically lands on one instance.
  // ─────────────────────────────────────────────────────────────────────
  const COOLDOWN_MS = 500;
  const _state = new Map(); // orgId -> { lastFiredAt, trailingTimer }

  async function _doRefresh(organizationId) {
    if (!organizationId) return { ok: false, reason: 'missing organizationId' };
    const skuRegex = await _resolveSkuRegex(organizationId);
    const start = Date.now();

    let dashboardOk = true, inventoryOk = true, boxOk = true;
    try {
      await _runTable('dashboard_summary',  organizationId, () => _rebuildDashboardSummary(organizationId, skuRegex));
    } catch { dashboardOk = false; }
    try {
      await _runTable('inventory_summary',  organizationId, () => _rebuildInventorySummary(organizationId, skuRegex));
    } catch { inventoryOk = false; }
    try {
      await _runTable('box_summary',        organizationId, () => _rebuildBoxSummary(organizationId));
    } catch { boxOk = false; }

    const totalMs = Date.now() - start;
    const allOk   = dashboardOk && inventoryOk && boxOk;
    logger?.[allOk ? 'info' : 'warn']?.(
      {
        event:                   'summary_refresh_complete',
        organization_id:         organizationId,
        duration_ms:             totalMs,
        dashboard_ok:            dashboardOk,
        inventory_ok:            inventoryOk,
        box_ok:                  boxOk,
      },
      allOk ? 'Summary tables rebuilt' : 'Summary refresh partial failure',
    );
    return { ok: allOk, ms: totalMs };
  }

  function refresh(organizationId) {
    if (!organizationId) return Promise.resolve({ ok: false, reason: 'missing organizationId' });

    const now   = Date.now();
    const state = _state.get(organizationId) || { lastFiredAt: 0, trailingTimer: null };
    const sinceLast = now - state.lastFiredAt;

    if (sinceLast >= COOLDOWN_MS) {
      // Leading edge: fire immediately.
      if (state.trailingTimer) { clearTimeout(state.trailingTimer); state.trailingTimer = null; }
      state.lastFiredAt = now;
      _state.set(organizationId, state);
      return _doRefresh(organizationId);
    }

    // Inside cooldown: schedule (or keep) a trailing refresh that runs
    // when the cooldown window expires. Multiple calls inside the window
    // collapse onto the same timer.
    if (!state.trailingTimer) {
      const delay = COOLDOWN_MS - sinceLast;
      state.trailingTimer = setTimeout(() => {
        const s = _state.get(organizationId) || state;
        s.trailingTimer = null;
        s.lastFiredAt = Date.now();
        _state.set(organizationId, s);
        _doRefresh(organizationId).catch(() => {});
      }, delay);
      _state.set(organizationId, state);
    }
    return Promise.resolve({ ok: true, coalesced: true });
  }

  return { refresh };
}
