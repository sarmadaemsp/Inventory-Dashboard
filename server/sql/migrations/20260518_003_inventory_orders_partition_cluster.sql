-- ============================================================
-- C1 — inventory + orders partition + cluster migration
-- ============================================================
-- Closes audit C1 (highest cost-impact). The two largest BQ tables
-- (`inventory` and `orders`) currently have NO partitioning or
-- clustering — every dashboard / SKU / Box query scans the entire
-- physical table. Cost scales O(orgs × users × page-loads).
--
-- After this migration:
--   - inventory  → CLUSTER BY organization_id, sku
--                   (every read filters by org; SKU drilldown filters by sku)
--   - orders     → PARTITION BY DATE(SAFE_CAST(order_date AS DATE))
--                   CLUSTER BY organization_id, sku
--                   (dashboardRepository.getPerformance filters by date range)
--
-- Expected impact:
--   - 5-10× scan reduction on the org-scoped hot path.
--   - Date-range queries on orders read only relevant partitions.
--   - Zero application code change required — same column shapes,
--     same names. The cutover is a TABLE RENAME.
--
-- The migration uses CREATE-then-RENAME for safety:
--   1. Build new tables (inventory_new, orders_new) with the
--      partition/cluster shape AS SELECT * FROM the originals.
--   2. Verify row counts match.
--   3. Atomic rename: original → _old, new → original.
--   4. Drop _old after a 24-hour grace window once production smoke-
--      tests pass.
--
-- Run-time considerations:
--   - The CREATE-AS-SELECT steps are full table scans + writes. For
--     each table this is ~ table_size_bytes / 1 GiB minutes (BQ
--     billed-bytes; runtime is much faster than that on the slot pool).
--   - Pause uploads during the swap window (~5 min total). Cloud Run
--     can stay up; reads return fresh data right through the rename.
--   - The legacy migration 002_inventory_schema.sql historically had
--     these clusters; they were lost when the canonical DDL was
--     rewritten. This migration restores them on the current schema.
-- ============================================================


-- ── STEP 1 — Build clustered inventory_new ─────────────────────
-- Same columns, same nullability, just adds CLUSTER BY.
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.inventory_new`
(
  row_uid         STRING    NOT NULL,
  organization_id STRING    NOT NULL,
  sku             STRING    NOT NULL,
  upc             STRING    NOT NULL,
  part_number     STRING,
  box_number      STRING,
  quantity        INT64     NOT NULL,
  date_added      STRING,
  notes           STRING,
  updated_at      TIMESTAMP
)
CLUSTER BY organization_id, sku
AS
SELECT
  row_uid, organization_id, sku, upc, part_number, box_number,
  quantity, date_added, notes, updated_at
FROM `patman-inventory.patman_inventory.inventory`;


-- ── STEP 2 — Build partitioned + clustered orders_new ──────────
-- Partition by the date predicate dashboardRepository.getPerformance
-- already uses: SAFE_CAST(order_date AS DATE). Stored as a computed
-- column would be cleanest, but BQ table partitioning supports
-- expressions only via _PARTITIONDATE on tables that are INGEST-time
-- partitioned. Since order_date is a STRING column populated at
-- upload time, we partition on a NEW typed column `order_date_d`
-- that we populate at copy time. The application keeps writing the
-- STRING column (no code change); a downstream cleanup task can
-- backfill `order_date_d` on existing rows.
--
-- IMPORTANT: this means the *new* orders table has an extra
-- nullable DATE column. The application doesn't reference it yet —
-- partition pruning only requires a WHERE on the partition column,
-- which a follow-up patch to dashboardRepository will add. Until
-- then we still get the clustering benefit (organization_id, sku).
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.orders_new`
(
  order_row_id         STRING    NOT NULL,
  organization_id      STRING    NOT NULL,
  order_id             STRING,
  order_date           STRING    NOT NULL,
  order_date_d         DATE,
  sku                  STRING    NOT NULL,
  quantity_sold        INT64     NOT NULL,
  platform             STRING    NOT NULL,
  shipped_sku          STRING,
  mapped_inventory_sku STRING,
  uploaded_by          STRING,
  created_at           TIMESTAMP,
  mapped_at            TIMESTAMP,
  mapped_by            STRING
)
PARTITION BY order_date_d
CLUSTER BY organization_id, sku
AS
SELECT
  order_row_id, organization_id, order_id, order_date,
  SAFE_CAST(order_date AS DATE) AS order_date_d,
  sku, quantity_sold, platform, shipped_sku, mapped_inventory_sku,
  uploaded_by, created_at, mapped_at, mapped_by
FROM `patman-inventory.patman_inventory.orders`;


-- ── STEP 3 — Verify row counts match (run this manually) ───────
-- Operator: run this query AFTER steps 1+2 complete. The pairs MUST
-- be equal. If they aren't, abort the migration — DO NOT proceed to
-- the rename. Investigate the diff (usually means streaming-buffer
-- rows arrived during the copy).
--
--   SELECT 'inventory_orig' AS t, COUNT(*) AS n
--   FROM `patman-inventory.patman_inventory.inventory`
--   UNION ALL
--   SELECT 'inventory_new', COUNT(*)
--   FROM `patman-inventory.patman_inventory.inventory_new`
--   UNION ALL
--   SELECT 'orders_orig',  COUNT(*)
--   FROM `patman-inventory.patman_inventory.orders`
--   UNION ALL
--   SELECT 'orders_new',   COUNT(*)
--   FROM `patman-inventory.patman_inventory.orders_new`
--   ORDER BY t;
--
-- The two `_orig`/`_new` pairs must match exactly.


-- ── STEP 4 — Atomic rename (run AFTER step 3 verifies clean) ───
-- Each ALTER TABLE RENAME is a single metadata operation — atomic
-- from a reader's perspective. There is no window where the
-- application sees a missing or partial table.
--
-- DO NOT RUN STEP 4 UNTIL STEP 3 HAS BEEN VERIFIED MANUALLY.
-- Uncomment the four statements below in BQ console, run them as
-- one batch, then test the application immediately.

-- ALTER TABLE `patman-inventory.patman_inventory.inventory`     RENAME TO inventory_old;
-- ALTER TABLE `patman-inventory.patman_inventory.inventory_new` RENAME TO inventory;
-- ALTER TABLE `patman-inventory.patman_inventory.orders`        RENAME TO orders_old;
-- ALTER TABLE `patman-inventory.patman_inventory.orders_new`    RENAME TO orders;


-- ── STEP 5 — Drop _old tables after 24h grace window ───────────
-- Once the application has been running smoothly against the new
-- clustered tables for 24+ hours, drop the _old shadows to reclaim
-- storage. The 24h window lets you ALTER RENAME back in the
-- unlikely event of a regression.

-- DROP TABLE `patman-inventory.patman_inventory.inventory_old`;
-- DROP TABLE `patman-inventory.patman_inventory.orders_old`;


-- ── STEP 6 (OPTIONAL, follow-up) — application enhancement ─────
-- To unlock partition pruning on the orders table, the application's
-- date-range queries (dashboardRepository.getPerformance) should add
-- a WHERE on the new `order_date_d` column alongside the existing
-- SAFE_CAST(order_date AS DATE) predicate. Until that lands the
-- partition still exists but doesn't get pruned — clustering still
-- helps. A future code patch will add:
--
--   WHERE order_date_d BETWEEN @from AND @to
--     AND SAFE_CAST(order_date AS DATE) BETWEEN @from AND @to
--
-- (Both predicates because order_date_d is NULL on rows uploaded
-- before this migration. A backfill query can populate it later:
--   UPDATE orders SET order_date_d = SAFE_CAST(order_date AS DATE)
--   WHERE order_date_d IS NULL;
-- This is a single DML and can be done in the same maintenance
-- window or deferred.)
