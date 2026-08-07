-- ============================================================
-- 20260515_999 — ROLLBACK for inventory row_uid migration
-- ------------------------------------------------------------
-- Restores the inventory table from its pre-migration snapshot
-- and drops the row_uid column.
--
-- Run this ONLY if the new code that depends on row_uid is not
-- yet in production, OR you intend to roll back both schema and
-- code simultaneously.
-- ============================================================

-- Step 1: Replace live table with backup.
CREATE OR REPLACE TABLE `patman-inventory.patman_inventory.inventory` AS
SELECT * FROM `patman-inventory.patman_inventory.inventory_backup_20260515`;

-- Step 2: Drop the new column (defensive — backup likely doesn't have it,
-- but this guarantees a clean rollback state).
ALTER TABLE `patman-inventory.patman_inventory.inventory`
DROP COLUMN IF EXISTS row_uid;

-- Step 3: Verify row count matches the snapshot.
SELECT
  (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.inventory`)                  AS restored_count,
  (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.inventory_backup_20260515`)  AS backup_count;

-- Step 4 (optional, only after rollback is confirmed stable):
-- DROP TABLE `patman-inventory.patman_inventory.inventory_backup_20260515`;
