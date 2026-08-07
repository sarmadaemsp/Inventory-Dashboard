-- ============================================================
-- 20260514_999 — ROLLBACK for Phase C migration (20260514_003)
-- ------------------------------------------------------------
-- Run this ONLY if the Phase C migration caused issues you cannot
-- fix forward AND the Phase C runtime code has NOT yet been
-- deployed (i.e. production code is still reading role from
-- memberships.role).
--
-- This rollback:
--   1. Restores memberships from its pre-migration snapshot
--      (memberships were re-synced to users.role in Step D, so
--      we want the snapshot values back if any are different).
--   2. Drops the new users.role column.
--
-- After this completes, the schema is identical to the post-Phase-B
-- state and production keeps reading roles from memberships.role.
-- ============================================================

-- Step 1: Restore memberships from snapshot.
CREATE OR REPLACE TABLE `patman-inventory.patman_inventory.memberships` AS
SELECT *
FROM `patman-inventory.patman_inventory.memberships_backup_20260514`;


-- Step 2: Drop the new users.role column.
ALTER TABLE `patman-inventory.patman_inventory.users`
DROP COLUMN IF EXISTS role;


-- Step 3: Verify row counts and shape.
SELECT
  (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.memberships`)                 AS restored_count,
  (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.memberships_backup_20260514`) AS backup_count;

SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'users'
ORDER BY ordinal_position;


-- Step 4 (optional, run only after rollback is confirmed stable):
-- DROP TABLE `patman-inventory.patman_inventory.memberships_backup_20260514`;
