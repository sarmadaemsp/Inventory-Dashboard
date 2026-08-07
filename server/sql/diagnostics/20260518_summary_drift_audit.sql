-- ============================================================
-- Summary table drift audit (2026-05-18)
-- ------------------------------------------------------------
-- 1. Find&Replace ALL occurrences of  'REPLACE_WITH_ORG_ID'
--    with the actual organization_id you're investigating.
-- 2. Run each labeled query (A–E) independently in the BigQuery
--    console. Paste the WHOLE OUTPUT back to me.
--
-- Each query is fully self-contained — no DECLARE required, so
-- pasting any single block in isolation works.
-- ============================================================


-- ── A. Raw-table sanity ────────────────────────────────────────
-- How many rows in inventory + orders for this org? How many
-- DISTINCT SKUs? And the raw SUM(quantity).
-- This is what BOTH the live CTE and the materialized refresh see.
SELECT
  'raw_inventory'           AS source,
  COUNT(*)                  AS row_count,
  COUNT(DISTINCT sku)       AS distinct_skus,
  SUM(quantity)             AS sum_quantity
FROM `patman-inventory.patman_inventory.inventory`
WHERE organization_id = 'REPLACE_WITH_ORG_ID'

UNION ALL

SELECT
  'raw_orders'              AS source,
  COUNT(*)                  AS row_count,
  COUNT(DISTINCT sku)       AS distinct_skus,
  SUM(quantity_sold)        AS sum_quantity
FROM `patman-inventory.patman_inventory.orders`
WHERE organization_id = 'REPLACE_WITH_ORG_ID';


-- ── B. dashboard_summary row count ─────────────────────────────
-- Should be exactly 1. Any value > 1 means duplicate rows are
-- driving the inflated read (LIMIT 1 picks whichever).
SELECT
  COUNT(*) AS dashboard_summary_row_count,
  ARRAY_AGG(
    STRUCT(total_units, in_stock_skus, oos_skus, refreshed_at)
    ORDER BY refreshed_at DESC
    LIMIT 5
  ) AS recent_rows
FROM `patman-inventory.patman_inventory.dashboard_summary`
WHERE organization_id = 'REPLACE_WITH_ORG_ID';


-- ── C. inventory_summary duplicate (org, sku) detection ────────
-- Should return ZERO rows. Anything > 1 is direct evidence of a
-- MERGE race or a write-side bug.
SELECT
  sku,
  COUNT(*)                                                AS row_count,
  SUM(total_stock)                                        AS summed_total_stock,
  ARRAY_AGG(refreshed_at ORDER BY refreshed_at DESC LIMIT 3) AS refresh_times
FROM `patman-inventory.patman_inventory.inventory_summary`
WHERE organization_id = 'REPLACE_WITH_ORG_ID'
GROUP BY sku
HAVING COUNT(*) > 1
ORDER BY row_count DESC
LIMIT 20;


-- ── D. inventory_summary vs raw inventory parity ───────────────
-- Side-by-side: what inventory_summary currently has vs what the
-- canonical CTE would compute RIGHT NOW from raw rows. Emits only
-- the SKUs where they disagree.
WITH live AS (
  SELECT sku, SUM(quantity) AS live_total_stock
  FROM `patman-inventory.patman_inventory.inventory`
  WHERE organization_id = 'REPLACE_WITH_ORG_ID'
  GROUP BY sku
),
mat AS (
  SELECT sku, SUM(total_stock) AS mat_total_stock, COUNT(*) AS mat_row_count
  FROM `patman-inventory.patman_inventory.inventory_summary`
  WHERE organization_id = 'REPLACE_WITH_ORG_ID'
  GROUP BY sku
)
SELECT
  COALESCE(live.sku, mat.sku)                                              AS sku,
  live.live_total_stock,
  mat.mat_total_stock,
  mat.mat_row_count,
  COALESCE(mat.mat_total_stock, 0) - COALESCE(live.live_total_stock, 0)    AS total_stock_diff
FROM live
FULL OUTER JOIN mat USING (sku)
WHERE
  COALESCE(mat.mat_total_stock, 0) != COALESCE(live.live_total_stock, 0)
  OR mat.mat_row_count > 1
ORDER BY ABS(COALESCE(mat.mat_total_stock, 0) - COALESCE(live.live_total_stock, 0)) DESC
LIMIT 30;


-- ── E. dashboard_summary vs live recompute ─────────────────────
-- One-shot apples-to-apples on the dashboard aggregates. The
-- LIVE_RECOMPUTE row is what the CTE engine produces RIGHT NOW
-- from raw tables; the DASHBOARD_SUMMARY row(s) are what's stored.
-- If multiple DASHBOARD_SUMMARY rows appear, that itself is the bug.
WITH orders_agg AS (
  SELECT
    COALESCE(NULLIF(TRIM(shipped_sku), ''), sku) AS effective_sku,
    SUM(quantity_sold)                           AS ordered
  FROM `patman-inventory.patman_inventory.orders`
  WHERE organization_id = 'REPLACE_WITH_ORG_ID'
  GROUP BY effective_sku
),
inv_agg AS (
  SELECT sku, SUM(quantity) AS sku_qty
  FROM `patman-inventory.patman_inventory.inventory`
  WHERE organization_id = 'REPLACE_WITH_ORG_ID'
  GROUP BY sku
),
per_sku AS (
  SELECT
    i.sku,
    i.sku_qty                                          AS initial,
    COALESCE(o.ordered, 0)                             AS sold,
    LEAST(COALESCE(o.ordered, 0), i.sku_qty)           AS fulfilled,
    GREATEST(COALESCE(o.ordered, 0) - i.sku_qty, 0)    AS phantom,
    GREATEST(i.sku_qty - COALESCE(o.ordered, 0), 0)    AS remaining
  FROM inv_agg i
  LEFT JOIN orders_agg o ON i.sku = o.effective_sku
),
live_totals AS (
  SELECT
    'LIVE_RECOMPUTE'               AS source,
    COUNT(*)                       AS total_skus,
    SUM(initial)                   AS total_units,
    SUM(fulfilled)                 AS fulfilled_units,
    SUM(phantom)                   AS phantom_units,
    SUM(remaining)                 AS physical_remaining_units,
    COUNTIF(remaining > 0)         AS in_stock_skus,
    COUNTIF(remaining = 0)         AS oos_skus,
    COUNTIF(phantom > 0)           AS phantom_skus
  FROM per_sku
),
mat_totals AS (
  SELECT
    'DASHBOARD_SUMMARY'        AS source,
    total_skus,
    total_units,
    fulfilled_units,
    phantom_units,
    physical_remaining_units,
    in_stock_skus,
    oos_skus,
    phantom_skus
  FROM `patman-inventory.patman_inventory.dashboard_summary`
  WHERE organization_id = 'REPLACE_WITH_ORG_ID'
)
SELECT * FROM live_totals
UNION ALL
SELECT * FROM mat_totals;
