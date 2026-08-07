-- ============================================================
-- 20260513_003 — users table → canonical schema
-- ------------------------------------------------------------
-- DESTRUCTIVE. Drops legacy single-tenant columns from users.
-- DO NOT RUN until:
--   1. 20260513_001_pre_migration_validation.sql returned clean (Check 1, 4).
--   2. 20260513_002_backup_users.sql succeeded and row counts matched.
--   3. Application code is already deployed in the version that does
--      NOT write to or read from users.organization_id or users.role.
--
-- BigQuery supports IF EXISTS on DROP COLUMN — every step is idempotent.
-- Running twice is safe.
-- ============================================================

-- ── Step A ──────────────────────────────────────────────────
-- Add updated_at column. The runtime expects to write to this
-- column on INSERT and every UPDATE. Pre-migration the column
-- does NOT exist in production, so user writes were silently
-- failing. After this step, writes succeed.
ALTER TABLE `patman-inventory.patman_inventory.users`
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;


-- ── Step B ──────────────────────────────────────────────────
-- DROP email column entirely.
-- Email is not a login credential and is no longer collected by
-- the admin user-creation form. Pre-migration validation Check 3
-- confirmed there are no email collisions to worry about, and the
-- runtime no longer reads or writes this column after deployment
-- of the Phase B code changes.
ALTER TABLE `patman-inventory.patman_inventory.users`
DROP COLUMN IF EXISTS email;


-- ── Step C ──────────────────────────────────────────────────
-- Drop legacy organization_id column from users.
-- Org membership is now exclusively tracked via the memberships table.
-- Pre-migration validation Check 1 confirmed every user has at
-- least one membership row, so no org access is lost.
ALTER TABLE `patman-inventory.patman_inventory.users`
DROP COLUMN IF EXISTS organization_id;


-- ── Step D ──────────────────────────────────────────────────
-- Drop legacy role column from users.
-- Roles currently live on memberships.role (per-org). Phase C will
-- introduce a global users.role column with the 3-tier model
-- (viewer / user / admin). The legacy column is a duplicate
-- authority source and causes drift, so it must go before Phase C.
ALTER TABLE `patman-inventory.patman_inventory.users`
DROP COLUMN IF EXISTS role;


-- ============================================================
-- Post-step verification: confirm final column set matches
-- the canonical DDL in schema/02_users.sql.
--
-- Expected columns AFTER this migration:
--   user_id, username, password_hash, display_name,
--   is_active, created_at, updated_at
--
-- Expected NOT NULL columns:
--   user_id, username, password_hash, display_name, is_active, created_at
--
-- Expected nullable columns:
--   updated_at
-- ============================================================
SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'users'
ORDER BY ordinal_position;
