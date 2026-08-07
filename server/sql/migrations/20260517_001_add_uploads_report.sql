-- ============================================================
-- 20260517_001 — Add report STRING column to upload tables
-- ------------------------------------------------------------
-- The pipeline now generates a human-readable plain-text summary
-- report for every upload (rows added/updated/removed, failed
-- count, full error list) and persists it alongside the upload
-- audit row. Admins / managers can download it from the Upload
-- History table on the Uploads page.
--
-- Nullable: legacy rows (uploaded before this migration) keep
-- report = NULL and the UI displays "—" for those.
-- ============================================================

ALTER TABLE `patman-inventory.patman_inventory.inventory_uploads`
ADD COLUMN IF NOT EXISTS report STRING;

ALTER TABLE `patman-inventory.patman_inventory.order_uploads`
ADD COLUMN IF NOT EXISTS report STRING;


-- Verification:
SELECT table_name, column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name IN ('inventory_uploads', 'order_uploads')
  AND column_name = 'report';
