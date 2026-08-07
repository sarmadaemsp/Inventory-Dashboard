-- ============================================================
-- 20260514_001 — Phase C pre-migration validation
-- ------------------------------------------------------------
-- Run BEFORE 20260514_003_global_roles_migration.sql.
-- Confirms it is safe to collapse per-org roles into a single
-- global role on the users table.
--
-- These are pure SELECT queries — nothing is mutated.
--
-- DEPENDS ON: Phase B migration (20260513_*) having completed.
--   If it has not, `users.role` will still exist and this script
--   will warn at Check 4.
-- ============================================================

-- ── Check 1 ─────────────────────────────────────────────────
-- Every existing user MUST have at least one membership.
-- Without a membership, we cannot derive a role for them.
-- Expected: 0 rows.
SELECT u.user_id, u.username
FROM `patman-inventory.patman_inventory.users` u
LEFT JOIN `patman-inventory.patman_inventory.memberships` m
  ON m.user_id = u.user_id AND m.is_active = TRUE
WHERE m.membership_id IS NULL;


-- ── Check 2 ─────────────────────────────────────────────────
-- Per-user role consistency: every membership for the same user
-- must share the same role tier (admin / operational / view).
-- Pre-Phase-C the schema allowed divergence, but the user spec
-- requires global roles. Phase B Check 2 already verified zero
-- divergence on legacy users.role vs memberships.role — this
-- now does the same across multiple memberships per user.
--
-- Tier mapping (used here AND in 003 backfill):
--   admin / organization_admin / super_admin      → tier 3 (admin)
--   manager / staff / operator / user             → tier 2 (user)
--   viewer / view / other / null                  → tier 1 (view)
--
-- Expected: 0 rows. Any row here means a user has memberships
-- with conflicting tiers; resolve manually before proceeding.
WITH per_membership AS (
  SELECT
    m.user_id,
    CASE
      WHEN m.role IN ('admin', 'organization_admin', 'super_admin') THEN 3
      WHEN m.role IN ('manager', 'staff', 'operator', 'user')       THEN 2
      ELSE                                                                1
    END AS tier
  FROM `patman-inventory.patman_inventory.memberships` m
  WHERE m.is_active = TRUE
)
SELECT user_id, MIN(tier) AS min_tier, MAX(tier) AS max_tier, COUNT(*) AS membership_count
FROM per_membership
GROUP BY user_id
HAVING MIN(tier) != MAX(tier);


-- ── Check 3 ─────────────────────────────────────────────────
-- Confirm no unrecognised role string exists in memberships
-- (so the tier mapping above is exhaustive).
-- Expected: 0 rows.
SELECT DISTINCT role
FROM `patman-inventory.patman_inventory.memberships`
WHERE role NOT IN ('admin', 'organization_admin', 'super_admin',
                   'manager', 'staff', 'operator', 'user',
                   'viewer', 'view');


-- ── Check 4 ─────────────────────────────────────────────────
-- Phase B must have completed before Phase C runs.
-- Expected: 0 rows (legacy columns already dropped by Phase B).
-- If you see 'role' or 'organization_id' or 'email' here, STOP —
-- run Phase B first.
SELECT column_name
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'users'
  AND column_name IN ('organization_id', 'role', 'email');


-- ── Check 5 ─────────────────────────────────────────────────
-- Confirm memberships.role currently exists (we will read from it).
-- Expected: 1 row.
SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'memberships' AND column_name = 'role';
