-- ============================================================
-- 20260514_002 — Backup snapshot of the memberships table
-- ------------------------------------------------------------
-- Phase C does NOT drop memberships.role (that happens in Phase D),
-- so this backup is defence-in-depth in case the backfill itself
-- corrupts a row. The migration only ADDs users.role and writes
-- to it; memberships rows are untouched.
--
-- Backup table name encodes the migration date.
-- ============================================================

CREATE OR REPLACE TABLE `patman-inventory.patman_inventory.memberships_backup_20260514` AS
SELECT *
FROM `patman-inventory.patman_inventory.memberships`;


-- Confirm the backup row count matches the live table:
--   SELECT
--     (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.memberships`)                AS live_count,
--     (SELECT COUNT(*) FROM `patman-inventory.patman_inventory.memberships_backup_20260514`) AS backup_count;
--
-- These two numbers MUST be equal before proceeding to 003.
