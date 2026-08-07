-- ============================================================
-- 20260516_001 — Add user-provided order_id to orders
-- ------------------------------------------------------------
-- The marketplace order number (Amazon order #, eBay sale ID, etc.)
-- is operational data that humans need on the Orders screen and in
-- exports. It is DISTINCT from the internal row tracker (order_row_id /
-- "UID") which the system uses for updates and deletes.
--
-- Naming:
--   order_row_id   — INTERNAL: UUID, immutable, used by API as row key
--   order_id       — EXTERNAL: human-meaningful marketplace order ID
--
-- This migration adds the column nullable so existing rows don't break.
-- Future Add/Remove uploads will require it (enforced in app code).
-- ============================================================

-- ── Step A ── Snapshot the table.
CREATE OR REPLACE TABLE `patman-inventory.patman_inventory.orders_backup_20260516` AS
SELECT * FROM `patman-inventory.patman_inventory.orders`;


-- ── Step B ── Add the column (nullable so existing rows are unaffected).
ALTER TABLE `patman-inventory.patman_inventory.orders`
ADD COLUMN IF NOT EXISTS order_id STRING;


-- Verification:
SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'orders'
ORDER BY ordinal_position;
