-- ============================================================
-- 20260514_004 — Phase C post-migration validation
-- ------------------------------------------------------------
-- Run AFTER 20260514_003 completes successfully.
-- Confirms the global-role model is in place and consistent.
-- ============================================================

-- ── Check 1 ─────────────────────────────────────────────────
-- Confirm users.role exists and is STRING.
-- Expected: 1 row. is_nullable will be YES because BigQuery's
-- ALTER ADD COLUMN cannot create a NOT NULL column on a non-empty
-- table — the application layer enforces non-null instead. If you
-- ran the optional rebuild block in Step C, is_nullable will be NO.
SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'users' AND column_name = 'role';


-- ── Check 1b ────────────────────────────────────────────────
-- Defence-in-depth: no row should actually have role = NULL.
-- Expected: 0 rows.
SELECT user_id, username
FROM `patman-inventory.patman_inventory.users`
WHERE role IS NULL;


-- ── Check 2 ─────────────────────────────────────────────────
-- Every user must have a role in the new 3-tier set.
-- Expected: 0 rows.
SELECT user_id, username, role
FROM `patman-inventory.patman_inventory.users`
WHERE role NOT IN ('admin', 'manager', 'viewer') OR role IS NULL;


-- ── Check 3 ─────────────────────────────────────────────────
-- Distribution check — informational. Shows how many users
-- ended up in each tier. No specific expectation; just sanity.
SELECT role, COUNT(*) AS n
FROM `patman-inventory.patman_inventory.users`
GROUP BY role
ORDER BY role;


-- ── Check 4 ─────────────────────────────────────────────────
-- memberships.role must equal users.role for every membership.
-- Expected: 0 rows. Phase D will then drop memberships.role.
SELECT m.membership_id, m.user_id, m.role AS membership_role, u.role AS user_role
FROM `patman-inventory.patman_inventory.memberships` m
JOIN `patman-inventory.patman_inventory.users`       u USING (user_id)
WHERE COALESCE(m.role, '') != COALESCE(u.role, '');


-- ── Check 5 ─────────────────────────────────────────────────
-- Re-confirm membership coverage. Every user still has at least
-- one membership (this should be unchanged from Phase B).
-- Expected: 0 rows.
SELECT u.user_id, u.username
FROM `patman-inventory.patman_inventory.users` u
LEFT JOIN `patman-inventory.patman_inventory.memberships` m
  ON m.user_id = u.user_id AND m.is_active = TRUE
WHERE m.membership_id IS NULL;


-- ── Check 6 ─────────────────────────────────────────────────
-- Final canonical users shape. Expected exactly 8 rows in order:
--   user_id        STRING    NO
--   username       STRING    NO
--   password_hash  STRING    NO
--   display_name   STRING    NO
--   role           STRING    NO
--   is_active      BOOL      NO
--   created_at     TIMESTAMP NO
--   updated_at     TIMESTAMP YES
SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'users'
ORDER BY ordinal_position;
