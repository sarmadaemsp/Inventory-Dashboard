-- ============================================================
-- 20260514_003 — Phase C: global roles migration
-- ------------------------------------------------------------
-- Adds `users.role` as the global platform role and backfills it
-- from each user's highest-tier membership role.
--
-- DOES NOT drop memberships.role yet — that happens in Phase D
-- once the runtime stops reading from it.
--
-- DO NOT RUN until:
--   1. Phase B migration 20260513_003 has completed in production.
--   2. 20260514_001 returned clean on Checks 1, 2, 3, 4, 5.
--   3. 20260514_002 backup created and row counts matched.
--   4. The current production code is still the post-Phase-B code
--      (which reads role from memberships.role via JWT). Phase C
--      runtime code MUST NOT be deployed until this migration finishes.
--
-- All steps are idempotent (IF NOT EXISTS guards + deterministic backfill).
-- Re-running on an already-migrated DB is safe.
-- ============================================================

-- ── Step A ──────────────────────────────────────────────────
-- Add users.role column. Initially nullable so the column can
-- exist before backfill runs; we tighten to NOT NULL in Step C.
ALTER TABLE `patman-inventory.patman_inventory.users`
ADD COLUMN IF NOT EXISTS role STRING;


-- ── Step B ──────────────────────────────────────────────────
-- Backfill users.role by collapsing the highest membership role
-- across each user's active memberships.
--
-- Canonical 3-tier global role model:
--   tier 3 (admin)   ← admin, organization_admin, super_admin
--   tier 2 (manager) ← manager, staff, operator, user
--   tier 1 (viewer)  ← viewer, view, anything else, null
--
-- Pre-validation Check 2 confirmed every user has a SINGLE tier
-- across all their memberships, so MAX() is deterministic — no
-- arbitrary tie-breaking happens.
UPDATE `patman-inventory.patman_inventory.users` u
SET role = (
  SELECT
    CASE MAX(
      CASE m.role
        WHEN 'admin'              THEN 3
        WHEN 'organization_admin' THEN 3
        WHEN 'super_admin'        THEN 3
        WHEN 'manager'            THEN 2
        WHEN 'staff'              THEN 2
        WHEN 'operator'           THEN 2
        WHEN 'user'               THEN 2
        WHEN 'viewer'             THEN 1
        WHEN 'view'               THEN 1
        ELSE                           1
      END
    )
      WHEN 3 THEN 'admin'
      WHEN 2 THEN 'manager'
      ELSE        'viewer'
    END
  FROM `patman-inventory.patman_inventory.memberships` m
  WHERE m.user_id = u.user_id
    AND m.is_active = TRUE
)
WHERE TRUE;


-- ── Step C ──────────────────────────────────────────────────
-- NOT NULL enforcement.
--
-- BigQuery does NOT support `ALTER COLUMN ... SET NOT NULL` on an
-- existing column. The only ways to make a column NOT NULL are:
--   (a) declare it at CREATE TABLE time, or
--   (b) rebuild the table via CREATE OR REPLACE TABLE … AS SELECT.
--
-- The application layer enforces non-null for users.role:
--   - usersService.create()         validates role ∈ {admin, manager, viewer}
--   - usersService.updateGlobalUser() rejects empty role
--   - The backfill above populated every existing row.
--
-- If you want a hard schema-level constraint, run this rebuild
-- BLOCK manually (commented out — uncomment and run as a single
-- multi-statement script). It atomically swaps the table:
--
--   CREATE OR REPLACE TABLE `patman-inventory.patman_inventory.users` (
--     user_id        STRING    NOT NULL,
--     username       STRING    NOT NULL,
--     password_hash  STRING    NOT NULL,
--     display_name   STRING    NOT NULL,
--     role           STRING    NOT NULL,
--     is_active      BOOL      NOT NULL,
--     created_at     TIMESTAMP NOT NULL,
--     updated_at     TIMESTAMP
--   ) AS
--   SELECT user_id, username, password_hash, display_name, role,
--          is_active, created_at, updated_at
--   FROM `patman-inventory.patman_inventory.users`;
--
-- Recommended: skip the rebuild for now. The application contract
-- already guarantees the invariant.


-- ── Step D ──────────────────────────────────────────────────
-- Normalise memberships.role to mirror the new global role.
-- This keeps the legacy field consistent during the Phase D
-- transition window. After Phase D drops the column, this step
-- becomes a no-op.
UPDATE `patman-inventory.patman_inventory.memberships` m
SET role = (
  SELECT u.role
  FROM `patman-inventory.patman_inventory.users` u
  WHERE u.user_id = m.user_id
)
WHERE TRUE;


-- ============================================================
-- Post-step verification: confirm every user has exactly one
-- of {admin, user, view} as their global role, and that
-- memberships mirror it.
--
-- Expected: 0 rows from both checks below.
-- ============================================================

-- Any user with an unexpected role value?
SELECT user_id, username, role
FROM `patman-inventory.patman_inventory.users`
WHERE role NOT IN ('admin', 'manager', 'viewer') OR role IS NULL;

-- Any membership whose role disagrees with the user's global role?
SELECT m.membership_id, m.user_id, m.role AS membership_role, u.role AS user_role
FROM `patman-inventory.patman_inventory.memberships` m
JOIN `patman-inventory.patman_inventory.users`       u USING (user_id)
WHERE COALESCE(m.role, '') != COALESCE(u.role, '');
