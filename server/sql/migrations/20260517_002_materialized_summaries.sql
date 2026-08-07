-- ============================================================
-- 20260517_002 — Materialized summary tables
-- ------------------------------------------------------------
-- Three read-optimized summaries that replace per-page CTE
-- aggregation. Populated by server/src/services/summaryRefreshService.js.
--
-- Refresh strategy:
--   - One row per (organization_id, ...key) per summary.
--   - Refresh runs after mutating operations: uploads, inventory
--     edit/delete, orders edit/delete, shipped-SKU reassign, org
--     sku_structure update.
--   - Refresh failures are NON-FATAL — they log a warning and the
--     caller proceeds. Reads still work because the parity logging
--     in dashboardService.getKPIs detects staleness and the in-memory
--     KPI cache (60s) papers over short windows.
--
-- Read paths (Phase B cutover):
--   dashboard_summary  → dashboardService.getKPIs
--   inventory_summary  → inventoryMetricsService.getSkuSummary
--   box_summary        → lookupRepository.search
--
-- Until Phase B cutover, read paths still use live CTEs and parity
-- logging compares summary table vs live CTE output. Cutover happens
-- only after observed parity = 0 diffs.
--
-- Clustering: all three cluster on organization_id (the universal
-- filter). inventory_summary additionally clusters on sku for fast
-- single-SKU drilldown. box_summary on upc for fast Box Lookup.
-- ============================================================

-- ── dashboard_summary ──────────────────────────────────────────
-- One row per organization. Powers Dashboard KPI cards.
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.dashboard_summary` (
  organization_id          STRING    NOT NULL,

  -- Inventory KPIs
  total_skus               INT64,
  total_units              INT64,
  fulfilled_units          INT64,
  phantom_units            INT64,
  physical_remaining_units INT64,
  in_stock_skus            INT64,
  oos_skus                 INT64,
  phantom_skus             INT64,
  undefined_skus           INT64,

  -- Sales KPIs
  units_sold_raw           INT64,
  unknown_units_sold       INT64,
  unknown_orders           INT64,
  wrong_part_units         INT64,
  total_orders             INT64,
  active_platforms         INT64,

  -- When this row was last rebuilt by summaryRefreshService.
  refreshed_at             TIMESTAMP NOT NULL
)
CLUSTER BY organization_id;


-- ── inventory_summary ──────────────────────────────────────────
-- One row per (organization_id, sku). Powers SKU View.
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.inventory_summary` (
  organization_id   STRING    NOT NULL,
  sku               STRING    NOT NULL,

  total_stock       INT64,    -- SUM(quantity) over all upload rows
  sold_units        INT64,    -- SUM(quantity_sold) over orders mapped to this SKU
  fulfilled_units   INT64,    -- LEAST(sold, total_stock)
  phantom_units     INT64,    -- GREATEST(sold - total_stock, 0)
  remaining_units   INT64,    -- GREATEST(total_stock - sold, 0)

  boxes_count       INT64,    -- COUNT(DISTINCT box_number)
  last_added_at     STRING,   -- MAX(date_added)
  part_number       STRING,   -- ANY_VALUE — same across all rows with this SKU by construction
  upc               STRING,   -- ANY_VALUE — same across all rows with this SKU by construction
  is_undefined      BOOL,     -- structure-regex + placeholder check

  refreshed_at      TIMESTAMP NOT NULL
)
CLUSTER BY organization_id, sku;


-- ── box_summary_by_upc + box_summary_by_part ──────────────────
-- One row per (organization_id, upc/part, ...) per table. Box Lookup
-- searches by EITHER upc OR part_number with equal frequency, so
-- single-key clustering on either column would leave the other path
-- with no pruning beyond the org. Two narrow tables, each clustered
-- for exactly one access pattern, give symmetric ~10 KB scans for
-- both search types instead of 10 KB / 10 MB asymmetric.
--
-- `upc_norm` / `part_norm` store the LOWER+TRIMmed form at write time
-- so the query can use literal equality on the clustered column
-- (clustering doesn't help LOWER(TRIM(upc)) — that's a computed
-- expression BigQuery can't map back to block-level stats).
--
-- Router lives in lookupRepository.search: detect the query shape
-- (numeric 8-14 digits → UPC table; else → part table; ambiguous →
-- query both and merge). summaryRefreshService writes BOTH tables
-- on every refresh inside the same per-org scope.

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.box_summary_by_upc` (
  organization_id   STRING    NOT NULL,
  upc_norm          STRING    NOT NULL,    -- LOWER(TRIM(upc)) for direct cluster pruning
  upc               STRING    NOT NULL,    -- original (display)
  part_number       STRING    NOT NULL,
  box_number        STRING    NOT NULL,

  initial_stock     INT64,
  fulfilled_units   INT64,
  phantom_units     INT64,
  remaining_stock   INT64,

  refreshed_at      TIMESTAMP NOT NULL
)
CLUSTER BY organization_id, upc_norm;

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.box_summary_by_part` (
  organization_id   STRING    NOT NULL,
  part_norm         STRING    NOT NULL,    -- LOWER(TRIM(part_number)) for direct cluster pruning
  upc               STRING    NOT NULL,
  part_number       STRING    NOT NULL,    -- original (display)
  box_number        STRING    NOT NULL,

  initial_stock     INT64,
  fulfilled_units   INT64,
  phantom_units     INT64,
  remaining_stock   INT64,

  refreshed_at      TIMESTAMP NOT NULL
)
CLUSTER BY organization_id, part_norm;


-- Verification: list the clustered columns for each summary table.
-- BigQuery exposes clustering metadata via INFORMATION_SCHEMA.COLUMNS
-- (not TABLES). Each clustered column has clustering_ordinal_position
-- set to its 1-based slot; non-clustered columns are NULL there.
SELECT
  table_name,
  ARRAY_AGG(column_name ORDER BY clustering_ordinal_position) AS cluster_keys
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name IN ('dashboard_summary', 'inventory_summary', 'box_summary_by_upc', 'box_summary_by_part')
  AND clustering_ordinal_position IS NOT NULL
GROUP BY table_name
ORDER BY table_name;


-- ── Upgrade note ──────────────────────────────────────────────
-- If an earlier revision of this migration was run and created a
-- single `box_summary` table, drop it manually after deploying the
-- new code:
--
--   DROP TABLE IF EXISTS `patman-inventory.patman_inventory.box_summary`;
--
-- No data loss — summaryRefreshService rebuilds both new tables from
-- raw inventory + orders on the next mutating operation per org.
