import { TABLES } from '../config/tables.js';
import { isUndefinedRowSql } from '../utils/inventoryPatterns.js';
import { effectiveSkuSql, wrongPartSql } from '../utils/skuPatterns.js';
import { ordersAggCTE, invAggCTE, perSkuCTE } from '../utils/skuPivots.js';

/**
 * inventoryMetricsService — single source of truth for dashboard KPI math.
 *
 * Reference: the user's Google Sheets pivot table grouped by SKU.
 *
 *   Pivot column        Definition (per SKU)
 *   ──────────────────  ────────────────────────────────────────────────
 *   Initial Stock       SUM(quantity)             over inventory rows
 *   Sold                SUM(quantity_sold)        over matched orders
 *                       (joined by effective_sku — shipped_sku
 *                        override applied)
 *   Fulfilled           LEAST(Sold, Initial)      capped to stock
 *   Phantom             GREATEST(Sold − Initial, 0)  oversold beyond stock
 *   Remaining           GREATEST(Initial − Sold, 0)  physical stock left
 *
 * Dashboard totals = SUM of each pivot column:
 *
 *   Total Units   = SUM(Initial)
 *   Sold matched  = SUM(Sold)           (sum across SKUs that exist in inv)
 *   Fulfilled     = SUM(Fulfilled)
 *   Phantom       = SUM(Phantom)
 *   Remaining     = SUM(Remaining)
 *
 * Dashboard counts:
 *
 *   Total SKUs    = COUNT(*) over per_sku           distinct SKUs
 *   In Stock      = COUNTIF(Remaining > 0)
 *   OOS           = COUNTIF(Remaining = 0)
 *   Phantom SKUs  = COUNTIF(Phantom > 0)
 *
 * "Unknown" (orders side) = quantity_sold for orders whose effective SKU
 * has NO row in inventory. Derived as:
 *
 *   unknownUnitsSold = unitsSoldRaw − soldMatched
 *
 * Identities that hold:
 *   Total Units = Fulfilled + Remaining                    (per-SKU)
 *   Sold matched = Fulfilled + Phantom                     (per-SKU)
 *   Units Sold  = Sold matched + Unknown                   (orders)
 *               = Fulfilled + Phantom + Unknown            (combining)
 */
// Parity logging for the SKU View read path. POST-cutover semantics:
//   - When READ_SKU_FROM_SUMMARY is ON (default), the request reads
//     from inventory_summary. If SUMMARY_PARITY_LOG=1, the LIVE CTE
//     runs in parallel as the parity probe.
//   - When READ_SKU_FROM_SUMMARY is OFF (rollback), the request reads
//     from the live CTE. If SUMMARY_PARITY_LOG=1, inventory_summary
//     runs in parallel as the parity probe (pre-cutover semantics).
const PARITY_LOG = process.env.SUMMARY_PARITY_LOG === '1';

// Phase B read-path cutover. Default ON: SKU View reads from
// inventory_summary. Flip to '0' on the Cloud Run revision to roll
// back to the live CTE path without redeploying any code.
const READ_FROM_SUMMARY = process.env.READ_SKU_FROM_SUMMARY !== '0';

export function createInventoryMetricsService({ bq, projectId, orgsRepo, logger }) {
  const invTable         = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable         = `\`${projectId}.${TABLES.ORDERS}\``;
  const inventorySummary = `\`${projectId}.${TABLES.INVENTORY_SUMMARY}\``;

  // CTE builders are imported from utils/skuPivots.js — the single source
  // of truth for the centralized allocation engine's SQL building blocks.
  // Both this service and summaryRefreshService consume the same fragments,
  // so live computation and materialized rebuild can never drift apart.
  const _ordersAggCTE  = ()           => ordersAggCTE({ ordTable });
  const _invAggCTE     = (regexParam) => invAggCTE({ invTable, regexParam });
  const _perSkuCTE     = ()           => perSkuCTE();

  // Resolve the org's compiled regex (cached in the repo). Returns null
  // when no structure is configured — callers should skip the param.
  async function _resolveSkuRegex(organizationId) {
    if (!orgsRepo?.getSkuRegex) return null;
    try { return await orgsRepo.getSkuRegex(organizationId); }
    catch { return null; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // computeSummary — ALL dashboard KPIs in one query
  // ─────────────────────────────────────────────────────────────────────────
  async function computeSummary(organizationId) {
    const skuRegex = await _resolveSkuRegex(organizationId);
    const regexParam = skuRegex ? 'sku_regex' : null;
    const p = { organizationId, ...(skuRegex ? { sku_regex: skuRegex } : {}) };

    // Mirror of the user's Google Sheets pivot: one row per distinct SKU,
    // then SUM/COUNTIF across SKUs for the dashboard KPIs.
    const summaryQuery = `
      WITH ${_ordersAggCTE()},
      ${_invAggCTE(regexParam)},
      ${_perSkuCTE()}
      SELECT
        COUNT(*)                       AS total_skus,                  -- distinct SKUs
        SUM(initial)                   AS total_inventory_units,       -- SUM Initial
        SUM(sold)                      AS sold_units_matched,          -- SUM Sold (matched only)
        SUM(fulfilled)                 AS fulfilled_units,             -- SUM Fulfilled
        SUM(phantom)                   AS phantom_units,               -- SUM Phantom
        SUM(remaining)                 AS physical_remaining_units,    -- SUM Remaining
        COUNTIF(remaining > 0)         AS in_stock_skus,               -- COUNTIF(Remaining > 0)
        COUNTIF(remaining = 0)         AS oos_skus,                    -- COUNTIF(Remaining = 0)
        COUNTIF(phantom > 0)           AS phantom_skus,                -- COUNTIF(Phantom > 0)
        COUNTIF(is_undefined)          AS undefined_inventory_rows
      FROM per_sku
    `;

    // Raw order totals + the Unknown counts.
    //   unknown_orders = COUNT(orders whose effective_sku has no inventory row)
    //   unknown_units  = SUM(quantity_sold) over the same set
    // Both come from one query that LEFT JOINs orders against the distinct
    // inventory SKU set. unknownUnitsSold was previously derived in JS as
    // (units_sold_raw − sold_units_matched); now sourced from SQL so a single
    // computation drives both Orders-count and Units-sum surfaces.
    //
    // wrong_part_units = SUM(quantity_sold) for rows where the operator
    // shipped a SKU with a different part-UPC than the ordered SKU.
    const ordersQuery = `
      WITH inv_skus AS (
        SELECT DISTINCT sku FROM ${invTable} WHERE organization_id = @organizationId
      ),
      o_eff AS (
        SELECT
          o.*,
          ${effectiveSkuSql({ skuCol: 'o.sku', shippedCol: 'o.shipped_sku' })} AS effective_sku
        FROM ${ordTable} o
        WHERE o.organization_id = @organizationId
      )
      SELECT
        COUNT(*)                                                            AS total_orders,
        SUM(o.quantity_sold)                                                AS units_sold_raw,
        SUM(IF(${wrongPartSql({ skuCol: 'o.sku', shippedCol: 'o.shipped_sku' })}, o.quantity_sold, 0)) AS wrong_part_units,
        COUNTIF(inv.sku IS NULL)                                            AS unknown_orders,
        SUM(IF(inv.sku IS NULL, o.quantity_sold, 0))                        AS unknown_units,
        COUNT(DISTINCT CASE WHEN o.platform IS NOT NULL THEN o.platform END) AS active_platforms,
        0                                                                   AS ignored_orders
      FROM o_eff o
      LEFT JOIN inv_skus inv ON COALESCE(o.mapped_inventory_sku, o.effective_sku) = inv.sku
    `;

    try {
      const [invRow, ordRow] = await Promise.all([
        bq.query({ query: summaryQuery, params: p }).then(r => r[0][0] ?? {}),
        bq.query({ query: ordersQuery,  params: p }).then(r => r[0][0] ?? {}),
      ]);

      // All four inventory sums come from the per-SKU pivot CTE (SQL above).
      // The pivot guarantees:
      //   total = fulfilled + remaining       (per SKU: LEAST + GREATEST)
      //   sold  = fulfilled + phantom         (per SKU: LEAST + GREATEST)
      // so summing across SKUs preserves both identities.
      const totalUnits             = Number(invRow.total_inventory_units    ?? 0);
      const soldMatched            = Number(invRow.sold_units_matched       ?? 0);
      const fulfilledUnits         = Number(invRow.fulfilled_units          ?? 0);
      const phantomUnits           = Number(invRow.phantom_units            ?? 0);
      const physicalRemainingUnits = Number(invRow.physical_remaining_units ?? 0);

      // Unknown UNITS + ORDERS both come from the orders query LEFT JOIN.
      // The unit total satisfies the identity
      //   Units Sold = Fulfilled + Phantom + Unknown
      // because Sold(matched) = Fulfilled + Phantom by the per-SKU pivot.
      const unitsSoldRaw     = Number(ordRow.units_sold_raw  ?? 0);
      const unknownUnitsSold = Number(ordRow.unknown_units   ?? 0);
      const unknownOrders    = Number(ordRow.unknown_orders  ?? 0);
      const wrongPartUnits   = Number(ordRow.wrong_part_units ?? 0);
      const actualUnitsSold  = fulfilledUnits;

      return {
        // Inventory KPIs — all per-SKU pivot sums and per-SKU counts
        totalSkus:              Number(invRow.total_skus               ?? 0),
        totalUnits:             totalUnits,
        soldUnitsMatched:       soldMatched,
        actualUnitsSold,
        fulfilledUnits,
        physicalRemainingUnits,
        phantomUnits,
        inStockSkus:            Number(invRow.in_stock_skus            ?? 0),
        oosSkus:                Number(invRow.oos_skus                 ?? 0),
        phantomSkus:            Number(invRow.phantom_skus             ?? 0),
        undefinedSkus:          Number(invRow.undefined_inventory_rows ?? 0),
        // Sales KPIs
        unitsSold:              unitsSoldRaw,
        unknownUnitsSold,
        unknownOrders,
        wrongPartUnits,
        totalOrders:            Number(ordRow.total_orders             ?? 0),
        activePlatforms:        Number(ordRow.active_platforms         ?? 0),
        ignoredOrders:          Number(ordRow.ignored_orders           ?? 0),
        // Aliases used by existing frontend field references
        remainingStock:         physicalRemainingUnits,
      };
    } catch (err) {
      console.error('[inventoryMetrics.computeSummary] failed:', err?.message ?? err);
      return {
        totalSkus: 0, totalUnits: 0, soldUnitsMatched: 0, actualUnitsSold: 0,
        fulfilledUnits: 0, physicalRemainingUnits: 0,
        phantomUnits: 0, inStockSkus: 0, oosSkus: 0, phantomSkus: 0, undefinedSkus: 0,
        unitsSold: 0, unknownUnitsSold: 0, unknownOrders: 0, wrongPartUnits: 0,
        totalOrders: 0, activePlatforms: 0, ignoredOrders: 0,
        remainingStock: 0,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getStockAnalytics — inventory intelligence charts and tables
  // All formulas use GREATEST/LEAST for correct physical stock math
  // ─────────────────────────────────────────────────────────────────────────
  async function getStockAnalytics(organizationId) {
    const skuRegex   = await _resolveSkuRegex(organizationId);
    const regexParam = skuRegex ? 'sku_regex' : null;
    const p = { organizationId, ...(skuRegex ? { sku_regex: skuRegex } : {}) };

    // Per-ROW classification, identical to computeSummary above. We slice
    // OOS into phantom and non-phantom so the chart can show both.
    const stockStatusQuery = `
      WITH ${_ordersAggCTE()},
      per_row AS (
        SELECT
          GREATEST(i.quantity - COALESCE(o.ordered, 0), 0) AS remaining,
          GREATEST(COALESCE(o.ordered, 0) - i.quantity, 0) AS phantom,
          ${isUndefinedRowSql('i', regexParam ? { regexParam } : {})} AS is_undefined
        FROM ${invTable} i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        WHERE i.organization_id = @organizationId
      )
      SELECT
        CASE
          WHEN is_undefined  THEN 'Undefined'
          WHEN phantom > 0   THEN 'Phantom'
          WHEN remaining = 0 THEN 'OOS'
          ELSE 'In Stock'
        END AS status,
        COUNT(*) AS count
      FROM per_row
      GROUP BY status
      ORDER BY count DESC
    `;

    const healthByMonthQuery = `
      WITH ${_ordersAggCTE()},
      per_row AS (
        SELECT
          LEFT(COALESCE(CAST(i.date_added AS STRING), ''), 7) AS month,
          GREATEST(i.quantity - COALESCE(o.ordered, 0), 0)    AS remaining,
          GREATEST(COALESCE(o.ordered, 0) - i.quantity, 0)    AS phantom
        FROM ${invTable} i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        WHERE i.organization_id = @organizationId
          AND i.date_added IS NOT NULL
          AND LENGTH(CAST(i.date_added AS STRING)) >= 7
      )
      SELECT
        month,
        COUNTIF(remaining > 0 AND phantom = 0) AS in_stock,
        COUNTIF(remaining = 0 AND phantom = 0) AS oos,
        COUNTIF(phantom > 0)                   AS phantom,
        COUNT(*)                               AS total
      FROM per_row
      WHERE month != '' AND month IS NOT NULL
      GROUP BY month
      ORDER BY month ASC
      LIMIT 24
    `;

    const run = (query, label) =>
      bq.query({ query, params: p })
        .then(r => r[0])
        .catch(err => {
          console.error(`[inventoryMetrics.getStockAnalytics] ${label} failed:`, err?.message ?? err);
          return [];
        });

    const [stockStatus, healthByMonth] = await Promise.all([
      run(stockStatusQuery,   'stockStatus'),
      run(healthByMonthQuery, 'healthByMonth'),
    ]);

    return { stockStatus, healthByMonth };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getSkuSummary — paginated SKU-level pivot rows for the Inventory List
  // (SKU View) page. Reuses the EXACT same CTEs that drive the dashboard
  // KPI sums, so per-row figures and per-org totals can never disagree:
  //
  //   row  i: SKU(i).initial / sold / fulfilled / phantom / remaining
  //   total: SUM over all SKUs (== dashboard KPI values)
  //
  // Filtering / sorting / search happen AFTER the pivot so the canonical
  // metrics are never altered by a UI request — the page is a pure read
  // of the same dataset.
  // ─────────────────────────────────────────────────────────────────────────
  async function getSkuSummary(organizationId, {
    page = 1, pageSize = 50, search = null, status = 'all',
    sortBy = 'sku', sortDir = 'asc',
  } = {}) {
    const skuRegex   = await _resolveSkuRegex(organizationId);
    const regexParam = skuRegex ? 'sku_regex' : null;
    const params     = { organizationId, ...(skuRegex ? { sku_regex: skuRegex } : {}) };

    // Status filters operate on the per-SKU pivot row, not on raw uploads.
    const whereParts = [];
    if (search) {
      // Match SKU, part-UPC suffix, or any of the extras (part_number, upc).
      whereParts.push('(LOWER(per_sku.sku) LIKE @search OR LOWER(COALESCE(extras.part_number, \'\')) LIKE @search OR LOWER(COALESCE(extras.upc, \'\')) LIKE @search)');
      params.search = `%${String(search).toLowerCase()}%`;
    }
    if (status === 'in_stock')  whereParts.push('per_sku.remaining > 0 AND NOT per_sku.is_undefined');
    if (status === 'oos')       whereParts.push('per_sku.remaining = 0 AND NOT per_sku.is_undefined');
    if (status === 'phantom')   whereParts.push('per_sku.phantom > 0');
    if (status === 'undefined') whereParts.push('per_sku.is_undefined');
    const whereCond = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const sortMap = {
      sku:        'per_sku.sku',
      initial:    'per_sku.initial',
      sold:       'per_sku.sold',
      fulfilled:  'per_sku.fulfilled',
      phantom:    'per_sku.phantom',
      remaining:  'per_sku.remaining',
      boxes:      'extras.boxes_count',
      last_added: 'extras.last_added_at',
    };
    const col = sortMap[sortBy] || 'per_sku.sku';
    const dir = sortDir === 'desc' ? 'DESC' : 'ASC';
    const offset = Math.max(0, (page - 1) * pageSize);

    // extras CTE: per-SKU box count + most recent upload date + canonical
    // part/upc lookups for display. ANY_VALUE is safe here because SKU is
    // structured as ARA{box}-{part}-{upc}; rows sharing a SKU agree on
    // part/upc by construction.
    const baseCTE = `
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
      )`;

    const dataQuery = `
      ${baseCTE}
      SELECT
        per_sku.sku,
        per_sku.initial      AS total_stock,
        per_sku.sold         AS sold_units,
        per_sku.fulfilled    AS fulfilled_units,
        per_sku.phantom      AS phantom_units,
        per_sku.remaining    AS remaining_units,
        per_sku.is_undefined AS is_undefined,
        extras.boxes_count   AS boxes_count,
        extras.last_added_at AS last_added_at,
        extras.part_number   AS part_number,
        extras.upc           AS upc
      FROM per_sku
      LEFT JOIN extras ON per_sku.sku = extras.sku
      ${whereCond}
      ORDER BY ${col} ${dir}, per_sku.sku ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const countQuery = `
      ${baseCTE}
      SELECT COUNT(*) AS total
      FROM per_sku
      LEFT JOIN extras ON per_sku.sku = extras.sku
      ${whereCond}
    `;

    // ── Phase B read-path: summary first, live as fallback ───────────────
    if (READ_FROM_SUMMARY) {
      try {
        const summary = await _readSkuSummaryFromTable(organizationId, {
          search, status, sortBy, sortDir, page, pageSize,
        });

        // Post-cutover parity probe (reverse direction): the LIVE CTE
        // runs in parallel against the summary read that served the
        // request. Lets operators verify drift after cutover.
        if (PARITY_LOG) {
          (async () => {
            try {
              const [rows, countRows] = await Promise.all([
                bq.query({ query: dataQuery,  params }),
                bq.query({ query: countQuery, params }),
              ]);
              const liveItems = rows[0].map(r => ({
                ...r,
                total_stock:     Number(r.total_stock     ?? 0),
                sold_units:      Number(r.sold_units      ?? 0),
                fulfilled_units: Number(r.fulfilled_units ?? 0),
                phantom_units:   Number(r.phantom_units   ?? 0),
                remaining_units: Number(r.remaining_units ?? 0),
                boxes_count:     Number(r.boxes_count     ?? 0),
                is_undefined:    !!r.is_undefined,
              }));
              const liveTotal = Number(countRows[0][0]?.total ?? 0);
              const diff = _diffSkuItems(liveItems, summary.items);
              if (summary.total !== liveTotal || diff) {
                logger?.warn?.(
                  { event: 'parity_sku_diff_post_cutover', organization_id: organizationId, live_total: liveTotal, summary_total: summary.total, diff_sample: diff ? { onlyInLive: diff.onlyInLive.slice(0,3), onlyInSummary: diff.onlyInSummary.slice(0,3), valueDiffs: diff.valueDiffs.slice(0,5) } : null },
                  'POST-CUTOVER: inventory_summary disagrees with live CTE',
                );
              } else {
                logger?.info?.(
                  { event: 'parity_sku_match', organization_id: organizationId, page_items: summary.items.length, total_skus: summary.total, post_cutover: true },
                  'inventory_summary matches live CTE (post-cutover probe)',
                );
              }
            } catch { /* swallow — probe must not affect requests */ }
          })();
        }

        return { items: summary.items, total: summary.total };
      } catch (err) {
        logger?.warn?.(
          { event: 'sku_summary_read_failed', organization_id: organizationId, err: err?.message },
          'inventory_summary read failed — falling back to live CTE',
        );
        // fall through to live CTE
      }
    }

    // ── Live CTE path (rollback / fallback) ──────────────────────────────
    try {
      const [rows, countRows] = await Promise.all([
        bq.query({ query: dataQuery,  params }),
        bq.query({ query: countQuery, params }),
      ]);
      const liveItems = rows[0].map(r => ({
        ...r,
        total_stock:     Number(r.total_stock     ?? 0),
        sold_units:      Number(r.sold_units      ?? 0),
        fulfilled_units: Number(r.fulfilled_units ?? 0),
        phantom_units:   Number(r.phantom_units   ?? 0),
        remaining_units: Number(r.remaining_units ?? 0),
        boxes_count:     Number(r.boxes_count     ?? 0),
        is_undefined:    !!r.is_undefined,
        last_added_at:   r.last_added_at?.value ?? r.last_added_at ?? null,
      }));
      const liveTotal = Number(countRows[0][0]?.total ?? 0);

      // Pre-cutover style parity probe (when rolled back).
      if (PARITY_LOG) {
        _skuSummaryParityProbe(organizationId, {
          search, status, sortBy, sortDir, page, pageSize,
        }, liveItems, liveTotal).catch(() => {});
      }

      return { items: liveItems, total: liveTotal };
    } catch (err) {
      console.error('[inventoryMetrics.getSkuSummary] failed:', err?.message ?? err);
      return { items: [], total: 0 };
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // SKU View parity probe (Phase A — gated by SUMMARY_PARITY_LOG=1)
  //
  // Runs the SAME logical filter/sort/pagination against inventory_summary
  // and diffs the row set against the live CTE result. Diff is keyed by
  // SKU and compares the six numeric pivot fields + is_undefined.
  // ─────────────────────────────────────────────────────────────────────
  async function _readSkuSummaryFromTable(organizationId, {
    search, status, sortBy, sortDir, page, pageSize,
  }) {
    const params = { organizationId };
    const where  = ['organization_id = @organizationId'];
    if (search) {
      where.push('(LOWER(sku) LIKE @search OR LOWER(COALESCE(part_number, \'\')) LIKE @search OR LOWER(COALESCE(upc, \'\')) LIKE @search)');
      params.search = `%${String(search).toLowerCase()}%`;
    }
    if (status === 'in_stock')  where.push('remaining_units > 0 AND NOT is_undefined');
    if (status === 'oos')       where.push('remaining_units = 0 AND NOT is_undefined');
    if (status === 'phantom')   where.push('phantom_units > 0');
    if (status === 'undefined') where.push('is_undefined');

    const sortMap = {
      sku:        'sku',
      initial:    'total_stock',
      sold:       'sold_units',
      fulfilled:  'fulfilled_units',
      phantom:    'phantom_units',
      remaining:  'remaining_units',
      boxes:      'boxes_count',
      last_added: 'last_added_at',
    };
    const col = sortMap[sortBy] || 'sku';
    const dir = sortDir === 'desc' ? 'DESC' : 'ASC';
    const offset = Math.max(0, (page - 1) * pageSize);

    const dataQuery = `
      SELECT sku, total_stock, sold_units, fulfilled_units, phantom_units,
             remaining_units, boxes_count, last_added_at, part_number, upc,
             is_undefined
      FROM ${inventorySummary}
      WHERE ${where.join(' AND ')}
      ORDER BY ${col} ${dir}, sku ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `;
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM ${inventorySummary}
      WHERE ${where.join(' AND ')}
    `;
    const [rows, countRows] = await Promise.all([
      bq.query({ query: dataQuery,  params }),
      bq.query({ query: countQuery, params }),
    ]);
    return {
      items: rows[0].map(r => ({
        sku:             r.sku,
        total_stock:     Number(r.total_stock     ?? 0),
        sold_units:      Number(r.sold_units      ?? 0),
        fulfilled_units: Number(r.fulfilled_units ?? 0),
        phantom_units:   Number(r.phantom_units   ?? 0),
        remaining_units: Number(r.remaining_units ?? 0),
        boxes_count:     Number(r.boxes_count     ?? 0),
        is_undefined:    !!r.is_undefined,
        last_added_at:   r.last_added_at?.value ?? r.last_added_at ?? null,
        part_number:     r.part_number ?? null,
        upc:             r.upc ?? null,
      })),
      total: Number(countRows[0][0]?.total ?? 0),
    };
  }

  function _diffSkuItems(live, summary) {
    const liveBySku    = new Map(live.map(r => [r.sku, r]));
    const summaryBySku = new Map(summary.map(r => [r.sku, r]));
    const onlyInLive    = [...liveBySku.keys()].filter(k => !summaryBySku.has(k));
    const onlyInSummary = [...summaryBySku.keys()].filter(k => !liveBySku.has(k));
    const valueDiffs    = [];
    const fields = ['total_stock', 'sold_units', 'fulfilled_units', 'phantom_units', 'remaining_units', 'boxes_count'];
    for (const [sku, l] of liveBySku) {
      const s = summaryBySku.get(sku);
      if (!s) continue;
      for (const f of fields) {
        if (Number(l[f] ?? 0) !== Number(s[f] ?? 0)) {
          valueDiffs.push({ sku, field: f, live: Number(l[f] ?? 0), summary: Number(s[f] ?? 0) });
        }
      }
      if (!!l.is_undefined !== !!s.is_undefined) {
        valueDiffs.push({ sku, field: 'is_undefined', live: !!l.is_undefined, summary: !!s.is_undefined });
      }
    }
    if (!onlyInLive.length && !onlyInSummary.length && !valueDiffs.length) return null;
    return { onlyInLive, onlyInSummary, valueDiffs };
  }

  async function _skuSummaryParityProbe(organizationId, opts, liveItems, liveTotal) {
    try {
      const summary = await _readSkuSummaryFromTable(organizationId, opts);
      if (!summary.items.length && liveItems.length) {
        logger?.warn?.(
          { event: 'parity_sku_summary_empty', organization_id: organizationId, live_count: liveItems.length },
          'inventory_summary returned empty — refresh may not have run for this org yet',
        );
        return;
      }
      if (summary.total !== liveTotal) {
        logger?.warn?.(
          { event: 'parity_sku_total_diff', organization_id: organizationId, live_total: liveTotal, summary_total: summary.total },
          'inventory_summary total disagrees with live CTE total',
        );
      }
      const diff = _diffSkuItems(liveItems, summary.items);
      if (diff) {
        logger?.warn?.(
          { event: 'parity_sku_diff', organization_id: organizationId, diff_sample: { onlyInLive: diff.onlyInLive.slice(0,3), onlyInSummary: diff.onlyInSummary.slice(0,3), valueDiffs: diff.valueDiffs.slice(0,5) } },
          'inventory_summary row set disagrees with live CTE',
        );
      } else {
        // Sample-size hint: page items count + total. /admin/parity-report
        // aggregates these so the operator can confirm sufficient sample
        // size before flipping the read-path cutover switch.
        logger?.info?.(
          {
            event: 'parity_sku_match',
            organization_id: organizationId,
            page_items:   liveItems.length,
            total_skus:   liveTotal,
          },
          'inventory_summary matches live CTE',
        );
      }
    } catch (err) {
      logger?.debug?.({ event: 'parity_sku_probe_failed', err: err?.message }, 'parity probe failed');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getRawRowsForFilteredSkus — raw upload rows for every SKU that matches
  // the SAME filter criteria as getSkuSummary. Powers the "Inventory List"
  // export option in the SKU View export chooser: operator sees an
  // aggregated table but wants to download every raw upload entry behind
  // those SKUs (UID, box, qty, dates, notes — the full audit trail).
  // ─────────────────────────────────────────────────────────────────────────
  async function getRawRowsForFilteredSkus(organizationId, {
    search = null, status = 'all',
  } = {}) {
    const skuRegex   = await _resolveSkuRegex(organizationId);
    const regexParam = skuRegex ? 'sku_regex' : null;
    const params     = { organizationId, ...(skuRegex ? { sku_regex: skuRegex } : {}) };

    const whereParts = [];
    if (search) {
      whereParts.push('(LOWER(per_sku.sku) LIKE @search OR LOWER(COALESCE(extras.part_number, \'\')) LIKE @search OR LOWER(COALESCE(extras.upc, \'\')) LIKE @search)');
      params.search = `%${String(search).toLowerCase()}%`;
    }
    if (status === 'in_stock')  whereParts.push('per_sku.remaining > 0 AND NOT per_sku.is_undefined');
    if (status === 'oos')       whereParts.push('per_sku.remaining = 0 AND NOT per_sku.is_undefined');
    if (status === 'phantom')   whereParts.push('per_sku.phantom > 0');
    if (status === 'undefined') whereParts.push('per_sku.is_undefined');
    const whereCond = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const query = `
      WITH ${_ordersAggCTE()},
      ${_invAggCTE(regexParam)},
      ${_perSkuCTE()},
      extras AS (
        SELECT sku, ANY_VALUE(part_number) AS part_number, ANY_VALUE(upc) AS upc
        FROM ${invTable}
        WHERE organization_id = @organizationId
        GROUP BY sku
      ),
      filtered_skus AS (
        SELECT per_sku.sku
        FROM per_sku
        LEFT JOIN extras ON per_sku.sku = extras.sku
        ${whereCond}
      )
      SELECT
        i.row_uid, i.sku, i.upc, i.part_number, i.box_number,
        i.quantity, i.date_added, i.notes, i.updated_at
      FROM ${invTable} i
      WHERE i.organization_id = @organizationId
        AND i.sku IN (SELECT sku FROM filtered_skus)
      ORDER BY i.sku ASC, COALESCE(i.updated_at, TIMESTAMP('1970-01-01')) DESC, i.date_added DESC
    `;

    try {
      const [rows] = await bq.query({ query, params });
      return rows.map(r => ({
        ...r,
        updated_at: r.updated_at?.value ?? r.updated_at ?? null,
      }));
    } catch (err) {
      console.error('[inventoryMetrics.getRawRowsForFilteredSkus] failed:', err?.message ?? err);
      return [];
    }
  }

  return { computeSummary, getStockAnalytics, getSkuSummary, getRawRowsForFilteredSkus };
}
