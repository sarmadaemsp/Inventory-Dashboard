import { TABLES } from '../config/tables.js';
import { ordersAggCTE } from '../utils/skuPivots.js';

// Parity logging for the Box Lookup read path. POST-cutover semantics
// (2026-05-18):
//   - When READ_BOX_FROM_SUMMARY is ON (default), search() reads from
//     box_summary_by_upc / box_summary_by_part directly. If
//     SUMMARY_PARITY_LOG=1, the LIVE CTE runs in parallel as the
//     parity probe.
//   - When READ_BOX_FROM_SUMMARY is OFF (rollback), search() reads
//     from the live CTE. If SUMMARY_PARITY_LOG=1, the summary tables
//     run in parallel as the parity probe (pre-cutover semantics).
const PARITY_LOG = process.env.SUMMARY_PARITY_LOG === '1';

// Phase B read-path cutover (2026-05-18). Default ON: Box Lookup reads
// from the materialized box_summary_by_upc / box_summary_by_part
// tables. Flip to '0' on the Cloud Run revision to roll back to the
// live CTE path without redeploying any code.
const READ_FROM_SUMMARY = process.env.READ_BOX_FROM_SUMMARY !== '0';

// UPC heuristic — 8-14 digit numeric. UPC-A is 12, EAN-13 is 13,
// EAN-8 is 8, ITF-14 is 14. Anything else routes to part_number first.
function looksLikeUpc(q) {
  return /^\d{8,14}$/.test(q);
}

export function createLookupRepository({ bq, projectId, logger }) {
  const invTable = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable = `\`${projectId}.${TABLES.ORDERS}\``;
  const byUpc    = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_UPC}\``;
  const byPart   = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_PART}\``;

  // ─────────────────────────────────────────────────────────────────
  // _searchLive — canonical Box Lookup. Aggregates raw inventory + orders
  // via the shared ordersAggCTE so the math is identical to dashboard +
  // SKU View + summaryRefreshService.
  // ─────────────────────────────────────────────────────────────────
  async function _searchLive(organizationId, query) {
    const q = (query || '').trim();
    if (!q) return [];

    const sql = `
      WITH inv_grouped AS (
        SELECT
          COALESCE(upc, '')         AS upc,
          COALESCE(part_number, '') AS part_number,
          COALESCE(box_number, '')  AS box_number,
          SUM(quantity)             AS initial_stock
        FROM ${invTable}
        WHERE organization_id = @organizationId
          AND (
            LOWER(TRIM(COALESCE(upc, '')))            = LOWER(TRIM(@query))
            OR LOWER(TRIM(COALESCE(part_number, ''))) = LOWER(TRIM(@query))
          )
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
          AND (
            LOWER(TRIM(COALESCE(upc, '')))            = LOWER(TRIM(@query))
            OR LOWER(TRIM(COALESCE(part_number, ''))) = LOWER(TRIM(@query))
          )
      ),
      ${ordersAggCTE({ ordTable })},
      box_orders AS (
        SELECT
          s.upc, s.part_number, s.box_number,
          COALESCE(SUM(o.ordered), 0) AS units_sold
        FROM inv_skus s
        LEFT JOIN orders_agg o ON s.sku = o.effective_sku
        GROUP BY s.upc, s.part_number, s.box_number
      )
      SELECT
        ig.upc, ig.part_number, ig.box_number,
        ig.initial_stock,
        LEAST(COALESCE(bo.units_sold, 0), ig.initial_stock)        AS fulfilled_units,
        GREATEST(COALESCE(bo.units_sold, 0) - ig.initial_stock, 0) AS phantom_units,
        GREATEST(ig.initial_stock - COALESCE(bo.units_sold, 0), 0) AS remaining_stock
      FROM inv_grouped ig
      LEFT JOIN box_orders bo
        ON  ig.box_number  = bo.box_number
        AND ig.part_number = bo.part_number
        AND ig.upc         = bo.upc
      ORDER BY ig.part_number, ig.upc, remaining_stock DESC
    `;

    const [rows] = await bq.query({
      query:  sql,
      params: { organizationId, query: q },
    });
    return rows;
  }

  // ─────────────────────────────────────────────────────────────────
  // _searchFromSummary — read from box_summary_by_upc / box_summary_by_part.
  // Routes by query shape (UPC vs part_number) using the normalized
  // cluster column for cluster-pruned scans.
  // ─────────────────────────────────────────────────────────────────
  async function _searchFromSummary(organizationId, query) {
    const raw = (query || '').trim();
    if (!raw) return [];
    const normalized = raw.toLowerCase();

    const sqlByUpc = `
      SELECT upc, part_number, box_number,
             initial_stock, fulfilled_units, phantom_units, remaining_stock
      FROM ${byUpc}
      WHERE organization_id = @organizationId
        AND upc_norm        = @q
      ORDER BY part_number, upc, remaining_stock DESC
    `;
    const sqlByPart = `
      SELECT upc, part_number, box_number,
             initial_stock, fulfilled_units, phantom_units, remaining_stock
      FROM ${byPart}
      WHERE organization_id = @organizationId
        AND part_norm       = @q
      ORDER BY part_number, upc, remaining_stock DESC
    `;

    const first = looksLikeUpc(raw) ? sqlByUpc : sqlByPart;
    const next  = looksLikeUpc(raw) ? sqlByPart : sqlByUpc;

    const [firstRows] = await bq.query({ query: first, params: { organizationId, q: normalized } });
    if (firstRows.length) return firstRows;
    const [nextRows]  = await bq.query({ query: next,  params: { organizationId, q: normalized } });
    return nextRows;
  }

  // Compare two result sets and return a structured diff. Box Lookup
  // results are an unordered set of (upc, part, box) triples plus four
  // numeric fields. Compare as a key→record map so order doesn't matter.
  function _diffResults(live, summary) {
    const key = r => `${r.upc}|${r.part_number}|${r.box_number}`;
    const liveMap    = new Map(live.map(r => [key(r), r]));
    const summaryMap = new Map(summary.map(r => [key(r), r]));

    const onlyInLive    = [...liveMap.keys()].filter(k => !summaryMap.has(k));
    const onlyInSummary = [...summaryMap.keys()].filter(k => !liveMap.has(k));
    const valueDiffs    = [];
    for (const [k, l] of liveMap) {
      const s = summaryMap.get(k);
      if (!s) continue;
      const fields = ['initial_stock', 'fulfilled_units', 'phantom_units', 'remaining_stock'];
      for (const f of fields) {
        if (Number(l[f] ?? 0) !== Number(s[f] ?? 0)) {
          valueDiffs.push({ key: k, field: f, live: Number(l[f] ?? 0), summary: Number(s[f] ?? 0) });
        }
      }
    }
    if (!onlyInLive.length && !onlyInSummary.length && !valueDiffs.length) return null;
    return { onlyInLive, onlyInSummary, valueDiffs };
  }

  function _coerceRows(rows) {
    return rows.map(r => ({
      ...r,
      initial_stock:   Number(r.initial_stock   ?? 0),
      fulfilled_units: Number(r.fulfilled_units ?? 0),
      phantom_units:   Number(r.phantom_units   ?? 0),
      remaining_stock: Number(r.remaining_stock ?? 0),
    }));
  }

  async function search(organizationId, query) {
    // ── Phase B read-path: summary first, live as fallback ──────────────
    if (READ_FROM_SUMMARY) {
      try {
        const summary = await _searchFromSummary(organizationId, query);

        // Post-cutover parity probe (reverse direction): the LIVE CTE
        // runs in parallel against the summary read that just served
        // the request. Lets operators verify drift after cutover.
        if (PARITY_LOG) {
          _searchLive(organizationId, query).then(live => {
            const diff = _diffResults(live, summary);
            if (live.length && !summary.length) {
              logger?.warn?.(
                { event: 'parity_box_diff_post_cutover', organization_id: organizationId, query, reason: 'summary_empty', live_count: live.length },
                'POST-CUTOVER: box_summary_by_* returned empty but live CTE had rows',
              );
            } else if (diff) {
              logger?.warn?.(
                { event: 'parity_box_diff_post_cutover', organization_id: organizationId, query, diff },
                'POST-CUTOVER: box_summary_by_* disagrees with live CTE',
              );
            } else {
              logger?.info?.(
                { event: 'parity_box_match', organization_id: organizationId, query, live_count: live.length, post_cutover: true },
                'box_summary_by_* matches live CTE (post-cutover probe)',
              );
            }
          }).catch(() => {});
        }

        return _coerceRows(summary);
      } catch (err) {
        // Hard failure on the summary path (e.g. table missing,
        // permission revoked). Fall through to the live CTE so the
        // operator still gets results while they investigate.
        logger?.warn?.(
          { event: 'box_summary_read_failed', organization_id: organizationId, err: err?.message },
          'box_summary_by_* read failed — falling back to live CTE',
        );
      }
    }

    // ── Live CTE path (rollback / fallback) ──────────────────────────────
    const live = await _searchLive(organizationId, query);

    // Pre-cutover style parity probe: when reading from live, compare
    // against summary in parallel. Useful when rolled back to live to
    // verify the summary tables would have served the same answer.
    if (PARITY_LOG) {
      _searchFromSummary(organizationId, query).then(summary => {
        const diff = _diffResults(live, summary);
        if (!summary.length && live.length) {
          logger?.warn?.(
            { event: 'parity_box_summary_empty', organization_id: organizationId, query, live_count: live.length },
            'box_summary_by_* returned empty — refresh may not have run for this org yet',
          );
        } else if (diff) {
          logger?.warn?.(
            { event: 'parity_box_diff', organization_id: organizationId, query, diff },
            'box_summary_by_* disagrees with live CTE',
          );
        } else {
          logger?.info?.(
            { event: 'parity_box_match', organization_id: organizationId, query, live_count: live.length },
            'box_summary_by_* matches live CTE',
          );
        }
      }).catch(() => {});
    }

    return _coerceRows(live);
  }

  return { search };
}
