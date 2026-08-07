-- ============================================================
-- 20260516_003 — Consolidate shipped_from_box + shipped_sku_override
--                 into a single shipped_sku column
-- ------------------------------------------------------------
-- The two-column design was confusing:
--   shipped_from_box     — stored bare box digits ("352"), but the
--                          name implied a box, not a SKU.
--   shipped_sku_override — stored a full alternate SKU.
--
-- Operators always think in SKUs, not boxes. This migration:
--   1. Adds a single `shipped_sku` column.
--   2. Backfills from BOTH legacy columns (override wins).
--   3. Drops the two legacy columns.
--
-- effective_sku resolution in SQL (effectiveSkuSql) is updated to
-- parse `shipped_sku` directly: bare digits → box-only override,
-- full ARA SKU → verbatim. WRONG_PART status detection compares
-- the stored value's part-UPC suffix against the ordered SKU's.
-- ============================================================

-- ── Step A ── Snapshot the table.
CREATE OR REPLACE TABLE `patman-inventory.patman_inventory.orders_backup_20260516_c` AS
SELECT * FROM `patman-inventory.patman_inventory.orders`;


-- ── Step B ── Add the new column (nullable).
ALTER TABLE `patman-inventory.patman_inventory.orders`
ADD COLUMN IF NOT EXISTS shipped_sku STRING;


-- ── Step C ── Backfill. Override wins (full alternate SKU is the
-- richer signal). Otherwise fall back to the legacy box-digits column,
-- treating empty / whitespace as NULL.
UPDATE `patman-inventory.patman_inventory.orders`
SET shipped_sku = COALESCE(
  IF(shipped_sku_override IS NOT NULL AND TRIM(shipped_sku_override) != '', shipped_sku_override, NULL),
  IF(shipped_from_box     IS NOT NULL AND TRIM(shipped_from_box)     != '', shipped_from_box,     NULL)
)
WHERE TRUE;


-- ── Step D ── Verification: row counts should match between the
-- legacy columns and the new column.
SELECT
  COUNTIF(shipped_from_box     IS NOT NULL AND TRIM(shipped_from_box)     != '') AS legacy_box_rows,
  COUNTIF(shipped_sku_override IS NOT NULL AND TRIM(shipped_sku_override) != '') AS legacy_override_rows,
  COUNTIF(shipped_sku          IS NOT NULL AND TRIM(shipped_sku)          != '') AS new_shipped_sku_rows
FROM `patman-inventory.patman_inventory.orders`;


-- ── Step E ── Drop the legacy columns.
-- BigQuery supports ALTER TABLE ... DROP COLUMN since 2022.
-- Run AFTER verifying Step D shows the expected row counts.
ALTER TABLE `patman-inventory.patman_inventory.orders` DROP COLUMN IF EXISTS shipped_from_box;
ALTER TABLE `patman-inventory.patman_inventory.orders` DROP COLUMN IF EXISTS shipped_sku_override;


-- Final schema check:
SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'orders'
ORDER BY ordinal_position;
