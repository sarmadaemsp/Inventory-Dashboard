-- ============================================================
-- 20260516_002 — Add shipped_sku_override to orders
-- ------------------------------------------------------------
-- The existing `shipped_from_box` column stores ONLY the box digits
-- (e.g. "352"). The effective SKU is then reconstructed in SQL as
-- CONCAT('ARA', shipped_from_box, '-', part_number, '-', upc) using
-- the ORIGINAL ordered SKU's part-UPC suffix.
--
-- That works when fulfillment shipped the same part/UPC from a
-- different box, but it cannot represent a WRONG-PART override —
-- e.g. ordered ARA1045-4040338-037256451362 but actually shipped
-- ARA352-4060537-037256090684 (different part AND UPC). The old
-- code silently rebuilt the effective SKU using the original
-- part-UPC, which both lost the operator's intent and deducted
-- inventory from the wrong row.
--
-- This migration adds `shipped_sku_override` (full SKU). When set,
-- effective_sku resolution uses it verbatim and skips the box-rebuild
-- logic. NULL means "no full-SKU override" — falls through to the
-- legacy box-digits-only path for backwards compatibility.
-- ============================================================

-- ── Step A ── Snapshot the table.
CREATE OR REPLACE TABLE `patman-inventory.patman_inventory.orders_backup_20260516_b` AS
SELECT * FROM `patman-inventory.patman_inventory.orders`;


-- ── Step B ── Add the column (nullable so existing rows are unaffected).
ALTER TABLE `patman-inventory.patman_inventory.orders`
ADD COLUMN IF NOT EXISTS shipped_sku_override STRING;


-- Verification:
SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'orders'
ORDER BY ordinal_position;
