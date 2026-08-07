import { TABLES } from '../config/tables.js';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

function weekLabel(dateVal) {
  if (!dateVal) return '?';
  const d = new Date(dateVal?.value ?? dateVal);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// ── KPI cache ────────────────────────────────────────────────────────────────
// Per-org, in-memory, short TTL. The earlier 5-min cache was removed because
// it masked fresh metric runs after deploys/edits. This re-introduction is
// SAFE because every mutating route already calls invalidateKPICache(orgId):
//   - uploads.js (inventory + orders upload routes)
//   - inventory.js (PATCH + DELETE)
//   - orders.js   (PATCH + DELETE + reassign)
// So a cache hit can only occur within the same TTL window with no writes.
//
// TTL is short (60s) because dashboard summaries are the most-hit read path:
// even at 60s, dashboard load → tab focus → idle → tab focus pattern can be
// satisfied from cache. Anything > 2min would be perceptibly stale.
//
// This in-memory cache becomes optional after the materialized summary table
// cutover (Phase B of the audit follow-up). At that point reads are a single
// row-by-org SELECT and the cache is mostly redundant.
const KPI_TTL_MS = 60 * 1000;

// Parity logging mode. POST-cutover semantics (Phase B):
//   - When READ_FROM_SUMMARY is ON (default), the request reads from
//     dashboard_summary. If SUMMARY_PARITY_LOG=1, the LIVE CTE runs in
//     parallel as the parity probe (reverse of pre-cutover).
//   - When READ_FROM_SUMMARY is OFF (rollback), the request reads from
//     live CTE. If SUMMARY_PARITY_LOG=1, dashboard_summary runs in
//     parallel as the parity probe (pre-cutover semantics).
// Either way, parity logging is available for drift investigation after
// the read-path cutover.
const PARITY_LOG = process.env.SUMMARY_PARITY_LOG === '1';

// Phase B read-path cutover. Default ON: dashboard KPIs come from
// dashboard_summary. Flip to '0' on the Cloud Run revision to roll back
// to the live CTE path without redeploying any code.
//
// Auto-fallback: if the summary row is missing for an org (e.g. brand
// new org before its first refresh), this transparently falls back to
// the live CTE so the dashboard never goes dark. The fallback is logged
// at warn level — operator should hit /admin/summary-refresh for that
// org or wait for the next mutation to trigger a refresh.
const READ_FROM_SUMMARY = process.env.READ_DASHBOARD_FROM_SUMMARY !== '0';

// Numeric fields compared in parity mode. Order matches the dashboard
// frontend KPI_MAP so diffs read in the same order as the UI.
const PARITY_FIELDS = [
  'totalSkus', 'totalUnits', 'fulfilledUnits', 'phantomUnits',
  'physicalRemainingUnits', 'inStockSkus', 'oosSkus', 'phantomSkus',
  'undefinedSkus', 'unitsSold', 'unknownUnitsSold', 'unknownOrders',
  'wrongPartUnits', 'totalOrders', 'activePlatforms',
];

export function createDashboardService({ dashboardRepo, metricsService, bq, projectId, logger }) {
  // Map<organizationId, { value, expiresAt }>
  const _kpiCache = new Map();
  const dashboardSummaryTable = projectId
    ? `\`${projectId}.${TABLES.DASHBOARD_SUMMARY}\``
    : null;

  function _cacheGet(orgId) {
    const entry = _kpiCache.get(orgId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      _kpiCache.delete(orgId);
      return null;
    }
    return entry.value;
  }

  function _cacheSet(orgId, value) {
    _kpiCache.set(orgId, { value, expiresAt: Date.now() + KPI_TTL_MS });
  }

  // Read a single row out of dashboard_summary. Returns null on miss / error
  // so callers can transparently fall back to the live CTE path. Mapped to
  // the EXACT shape returned by computeSummary — including the derived
  // fields (soldUnitsMatched, actualUnitsSold, remainingStock alias,
  // ignoredOrders) so downstream renderers see one stable contract
  // regardless of which read path served the request.
  async function _readFromSummary(organizationId) {
    if (!bq || !dashboardSummaryTable) return null;
    try {
      const [rows] = await bq.query({
        query: `
          SELECT
            total_skus, total_units, fulfilled_units, phantom_units,
            physical_remaining_units, in_stock_skus, oos_skus, phantom_skus,
            undefined_skus, units_sold_raw, unknown_units_sold, unknown_orders,
            wrong_part_units, total_orders, active_platforms, refreshed_at
          FROM ${dashboardSummaryTable}
          WHERE organization_id = @organizationId
          LIMIT 1
        `,
        params: { organizationId },
      });
      const r = rows[0];
      if (!r) return null;
      const fulfilledUnits         = Number(r.fulfilled_units          ?? 0);
      const phantomUnits           = Number(r.phantom_units            ?? 0);
      const physicalRemainingUnits = Number(r.physical_remaining_units ?? 0);
      // soldUnitsMatched = fulfilled + phantom (per-SKU pivot identity)
      const soldUnitsMatched       = fulfilledUnits + phantomUnits;
      return {
        // Inventory KPIs
        totalSkus:              Number(r.total_skus               ?? 0),
        totalUnits:             Number(r.total_units              ?? 0),
        soldUnitsMatched,
        actualUnitsSold:        fulfilledUnits,
        fulfilledUnits,
        physicalRemainingUnits,
        phantomUnits,
        inStockSkus:            Number(r.in_stock_skus            ?? 0),
        oosSkus:                Number(r.oos_skus                 ?? 0),
        phantomSkus:            Number(r.phantom_skus             ?? 0),
        undefinedSkus:          Number(r.undefined_skus           ?? 0),
        // Sales KPIs
        unitsSold:              Number(r.units_sold_raw           ?? 0),
        unknownUnitsSold:       Number(r.unknown_units_sold       ?? 0),
        unknownOrders:          Number(r.unknown_orders           ?? 0),
        wrongPartUnits:         Number(r.wrong_part_units         ?? 0),
        totalOrders:            Number(r.total_orders             ?? 0),
        activePlatforms:        Number(r.active_platforms         ?? 0),
        ignoredOrders:          0,
        // Aliases used by existing frontend field references
        remainingStock:         physicalRemainingUnits,
        // Provenance + freshness signal (used by parity probes and admin UI)
        refreshed_at:           r.refreshed_at?.value ?? r.refreshed_at ?? null,
        _source:                'summary',
      };
    } catch (err) {
      logger?.warn?.(
        { event: 'summary_read_failed', organization_id: organizationId, err: err?.message },
        'dashboard_summary read failed — falling back to live CTE',
      );
      return null;
    }
  }

  function _diffParity(liveResult, summaryResult) {
    if (!summaryResult) return { missing: true };
    const diffs = {};
    for (const field of PARITY_FIELDS) {
      const live    = Number(liveResult[field]    ?? 0);
      const summary = Number(summaryResult[field] ?? 0);
      if (live !== summary) diffs[field] = { live, summary, delta: live - summary };
    }
    return Object.keys(diffs).length ? diffs : null;
  }

  async function getKPIs(organizationId) {
    const cached = _cacheGet(organizationId);
    if (cached) return cached;

    // ── Phase B read-path: summary first, live as fallback ──────────────
    if (READ_FROM_SUMMARY) {
      const summary = await _readFromSummary(organizationId);
      if (summary) {
        _cacheSet(organizationId, summary);

        // Post-cutover parity probe (reverse direction): the LIVE CTE
        // runs in parallel and we diff against the summary that just
        // served the request. Lets operators continue verifying drift
        // after cutover without affecting response latency.
        if (PARITY_LOG) {
          metricsService.computeSummary(organizationId).then(live => {
            const diff = _diffParity(live, summary);
            if (diff && !diff.missing) {
              logger?.warn?.(
                { event: 'parity_diff_post_cutover', organization_id: organizationId, diffs: diff, summary_refreshed_at: summary.refreshed_at },
                'POST-CUTOVER: dashboard_summary disagrees with live CTE',
              );
            } else {
              logger?.info?.(
                {
                  event: 'parity_match',
                  organization_id: organizationId,
                  summary_refreshed_at: summary.refreshed_at,
                  live_total_skus:     live.totalSkus,
                  live_total_units:    live.totalUnits,
                  live_total_orders:   live.totalOrders,
                  post_cutover:        true,
                },
                'dashboard_summary matches live CTE (post-cutover probe)',
              );
            }
          }).catch(() => {});
        }

        return summary;
      }

      // Auto-fallback: no summary row yet for this org (brand new org,
      // or refresh has never run). Drop through to the live CTE so the
      // dashboard never goes dark. Logged once so the operator can
      // schedule a /admin/summary-refresh.
      logger?.warn?.(
        { event: 'summary_missing_fallback', organization_id: organizationId },
        'dashboard_summary row missing — serving from live CTE instead. Run /admin/summary-refresh for this org.',
      );
    }

    // ── Live CTE path (rollback / fallback) ──────────────────────────────
    const fresh = await metricsService.computeSummary(organizationId);
    fresh._source = 'live';
    _cacheSet(organizationId, fresh);

    // Pre-cutover style parity probe: when reading from live, compare
    // against summary in parallel. Useful when rolled back to live to
    // verify the summary table would have served the same answer.
    if (PARITY_LOG) {
      _readFromSummary(organizationId).then(summary => {
        const diff = _diffParity(fresh, summary);
        if (!summary) {
          logger?.warn?.(
            { event: 'parity_summary_missing', organization_id: organizationId },
            'dashboard_summary row missing — refresh has not run for this org yet',
          );
        } else if (diff && !diff.missing) {
          logger?.warn?.(
            { event: 'parity_diff', organization_id: organizationId, diffs: diff, summary_refreshed_at: summary.refreshed_at },
            'dashboard_summary disagrees with live CTE — investigate refresh logic',
          );
        } else {
          logger?.info?.(
            {
              event: 'parity_match',
              organization_id: organizationId,
              summary_refreshed_at: summary.refreshed_at,
              live_total_skus:     fresh.totalSkus,
              live_total_units:    fresh.totalUnits,
              live_total_orders:   fresh.totalOrders,
            },
            'dashboard_summary matches live CTE',
          );
        }
      }).catch(() => {});
    }

    return fresh;
  }

  // Called from every mutating route (uploads / PATCH / DELETE / reassign).
  // Wipes the org's KPI cache so the next dashboard hit re-fetches fresh.
  function invalidateKPICache(organizationId) {
    if (organizationId) _kpiCache.delete(organizationId);
    else                _kpiCache.clear();
  }

  async function getPerformance(organizationId, weeks, platform = null) {
    const { weekly, platforms, topSkus, monthly } = await dashboardRepo.getPerformance(organizationId, weeks, platform);

    return {
      weekly: weekly.map(r => ({
        week_start:  r.week_start?.value ?? r.week_start,
        week_label:  weekLabel(r.week_start),
        units_sold:  Number(r.units_sold ?? 0),
        order_count: Number(r.orders     ?? 0),
      })),
      platforms: platforms.map(r => ({
        platform:    r.platform,
        units_sold:  Number(r.units_sold  ?? 0),
        order_count: Number(r.order_count ?? 0),
      })),
      topSkus: topSkus.map(r => ({
        sku:        r.sku,
        units_sold: Number(r.units_sold ?? 0),
      })),
      monthly: monthly.map(r => ({
        month:        r.month,
        month_label:  monthLabel(r.month),
        order_count:  Number(r.order_count ?? 0),
        units_sold:   Number(r.units_sold  ?? 0),
        top_platform: r.top_platform ?? '—',
      })),
    };
  }

  async function getInventoryAnalytics(organizationId) {
    const raw = await metricsService.getStockAnalytics(organizationId);

    return {
      stockStatus: raw.stockStatus.map(r => ({
        status: r.status,
        count:  Number(r.count ?? 0),
      })),
      healthByMonth: raw.healthByMonth.map(r => ({
        month:    r.month,
        in_stock: Number(r.in_stock ?? 0),
        oos:      Number(r.oos      ?? 0),
        phantom:  Number(r.phantom  ?? 0),
        total:    Number(r.total    ?? 0),
      })),
    };
  }

  return { getKPIs, getPerformance, getInventoryAnalytics, invalidateKPICache };
}
