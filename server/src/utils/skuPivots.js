/**
 * skuPivots — SHARED CTE builders for inventory + orders aggregation.
 *
 * THE single source of truth for the centralized allocation engine's
 * SQL building blocks. Every consumer (live computation in
 * inventoryMetricsService, materialized rebuild in summaryRefreshService,
 * box-level aggregation in lookupRepository, popover alternates lookup
 * in inventoryRepository) imports the same fragments from here.
 *
 * Without this module, the same CTE definitions had been copy-pasted
 * across services and were free to drift. After this module, changing
 * the phantom / fulfilled / remaining formulas — or the SKU
 * normalization rule, or the undefined classification — happens in
 * ONE place and propagates to every read AND write path automatically.
 *
 * Contract for every CTE returned here:
 *   - Bound parameter: @organizationId (the caller MUST bind it).
 *   - Optional bound parameter: @<regexParam> for structure-regex
 *     classification. Pass { regexParam: 'sku_regex' } and bind the
 *     compiled regex string.
 *   - Table names come from the caller's `${tables}` map so the same
 *     CTE works against any BigQuery project / dataset.
 *
 * Calling pattern:
 *
 *   import { ordersAggCTE, invAggCTE, perSkuCTE } from '../utils/skuPivots.js';
 *
 *   const sql = `
 *     WITH ${ordersAggCTE({ ordTable })},
 *     ${invAggCTE({ invTable, regexParam })},
 *     ${perSkuCTE()}
 *     SELECT ... FROM per_sku
 *   `;
 */
import { isUndefinedSql } from './inventoryPatterns.js';
import { effectiveSkuSql } from './skuPatterns.js';

/**
 * orders_agg — orders aggregated by effective SKU (shipped_sku override
 * applied). One row per (effective_sku) for the requesting org.
 *
 * @param {{ ordTable: string }} opts — caller supplies the fully-qualified
 *        `\`project.dataset.orders\`` reference.
 */
export function ordersAggCTE({ ordTable }) {
  return `
    orders_agg AS (
      SELECT
        ${effectiveSkuSql()} AS effective_sku,
        SUM(quantity_sold) AS ordered
      FROM ${ordTable}
      WHERE organization_id = @organizationId
      GROUP BY effective_sku
    )`;
}

/**
 * inv_agg — inventory aggregated by SKU for the requesting org.
 * Emits sku_qty (SUM of quantity) and sku_is_undefined (centralized
 * classification via isUndefinedSql). When a structure regex is bound
 * via regexParam, the classifier also applies that regex.
 *
 * @param {{ invTable: string, regexParam?: string }} opts
 */
export function invAggCTE({ invTable, regexParam = null }) {
  const undefinedExpr = isUndefinedSql('sku', regexParam ? { regexParam } : {});
  return `
    inv_agg AS (
      SELECT
        sku,
        SUM(quantity)        AS sku_qty,
        ${undefinedExpr}     AS sku_is_undefined
      FROM ${invTable}
      WHERE organization_id = @organizationId
      GROUP BY sku
    )`;
}

/**
 * per_sku — the centralized allocation pivot. One row per distinct SKU,
 * with the canonical fulfilled / phantom / remaining math.
 *
 * Canonical formulas (single source — change here, propagates everywhere):
 *   initial    = SUM(quantity)              — total uploaded inventory
 *   sold       = SUM(quantity_sold)         — total orders mapped to effective SKU
 *   fulfilled  = LEAST(sold, initial)       — capped to physical stock
 *   phantom    = GREATEST(sold - initial,0) — demand-over-stock (informational)
 *   remaining  = GREATEST(initial - sold,0) — physical stock left (never < 0)
 *
 * Phantom rule (per CLAUDE.md): phantom is a SKU-level demand metric.
 * It NEVER reduces remaining_stock below zero. It is informational only.
 */
export function perSkuCTE() {
  return `
    per_sku AS (
      SELECT
        i.sku,
        i.sku_qty                                            AS initial,
        COALESCE(o.ordered, 0)                               AS sold,
        LEAST(COALESCE(o.ordered, 0), i.sku_qty)             AS fulfilled,
        GREATEST(COALESCE(o.ordered, 0) - i.sku_qty, 0)      AS phantom,
        GREATEST(i.sku_qty - COALESCE(o.ordered, 0), 0)      AS remaining,
        i.sku_is_undefined                                   AS is_undefined
      FROM inv_agg i
      LEFT JOIN orders_agg o ON i.sku = o.effective_sku
    )`;
}

/**
 * Convenience: the full 3-CTE prefix used by every read AND write path
 * that operates on the per-SKU pivot. Returns a string starting with
 * `WITH ...` and ending with the last CTE's closing paren — caller
 * appends their SELECT (or DML target) directly.
 *
 * Use this when the consumer ONLY needs per_sku and nothing else;
 * use the individual builders when extra CTEs (extras, o_eff, etc.)
 * also need to be in the WITH chain.
 */
export function perSkuPivotPrefix({ invTable, ordTable, regexParam = null }) {
  return `
    WITH ${ordersAggCTE({ ordTable })},
    ${invAggCTE({ invTable, regexParam })},
    ${perSkuCTE()}
  `;
}
