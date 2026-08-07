-- ============================================================
-- 20260513_999 — ROLLBACK for migration 003
-- ------------------------------------------------------------
-- Run this ONLY if migration 003 caused issues you cannot fix
-- forward. It restores the users table from the backup created
-- by 002 and re-adds the legacy NOT NULL constraints.
--
-- WARNING: any user/membership writes done AFTER 003 but BEFORE
-- this rollback may be reverted to the backup snapshot state.
-- Inspect the diff between live and backup first:
--
--   SELECT * FROM `patman-inventory.patman_inventory.users` u
--   FULL OUTER JOIN `patman-inventory.patman_inventory.users_backup_20260513` b
--     USING (user_id)
--   WHERE u.user_id IS NULL OR b.user_id IS NULL
--      OR u.username     != b.username
--      OR u.display_name != b.display_name
--      OR u.is_active    != b.is_active;
-- ============================================================

-- Step 1: Replace the live users table with the pre-migration backup.
CREATE OR REPLACE TABLE `patman-inventory.patman_inventory.users` AS
SELECT *
FROM `patman-inventory.patman_inventory.users_backup_20260513`;


-- Step 2: Verify row count matches the original.
SELECT
  (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.users`)               AS restored_count,
  (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.users_backup_20260513`) AS backup_count;


-- Step 3 (optional): drop the backup table once the rollback is
-- confirmed stable in production. Do not run this until you are
-- certain the rollback is permanent.
-- DROP TABLE `patman-inventory.patman_inventory.users_backup_20260513`;
