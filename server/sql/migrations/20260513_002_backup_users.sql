-- ============================================================
-- 20260513_002 — Backup snapshot of the users table
-- ------------------------------------------------------------
-- Creates a frozen copy of the users table BEFORE schema changes.
-- This is the rollback target if the migration causes issues.
--
-- Backup table name encodes the migration date so backups don't collide.
-- ============================================================

CREATE OR REPLACE TABLE `patman-inventory.patman_inventory.users_backup_20260513` AS
SELECT *
FROM `patman-inventory.patman_inventory.users`;


-- Confirm the backup row count matches the live table:
--   SELECT
--     (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.users`)               AS live_count,
--     (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.users_backup_20260513`) AS backup_count;
--
-- These two numbers MUST be equal before proceeding to 003.
