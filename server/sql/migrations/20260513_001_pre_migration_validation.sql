-- ============================================================
-- 20260513_001 — Pre-migration validation
-- ------------------------------------------------------------
-- Run BEFORE 003_users_canonical_migration.sql.
-- Every query below MUST return 0 rows or the expected count.
-- If any check fails, STOP and investigate before proceeding.
--
-- These are pure SELECT queries — no data is mutated.
-- ============================================================

-- ── Check 1 ─────────────────────────────────────────────────
-- Every existing user MUST have at least one membership row.
-- After we drop users.organization_id, the ONLY way to know
-- which orgs a user belongs to is the memberships table.
-- Expected: 0 rows.
SELECT
  u.user_id,
  u.username,
  u.organization_id AS legacy_org_id
FROM `patman-inventory.patman_inventory.users` u
LEFT JOIN `patman-inventory.patman_inventory.memberships` m
  ON m.user_id = u.user_id AND m.is_active = TRUE
WHERE m.membership_id IS NULL;


-- ── Check 2 ─────────────────────────────────────────────────
-- Spot-check role parity between users.role and memberships.role.
-- A user's legacy role should usually match the role on their
-- membership in the legacy organization_id. This is informational —
-- divergence is allowed (some users may have been promoted/demoted
-- on memberships without users.role being updated). Phase C will
-- collapse to 3 global roles regardless.
-- Expected: shows the mismatches that exist (any number is fine).
SELECT
  u.user_id,
  u.username,
  u.organization_id AS legacy_org_id,
  u.role            AS legacy_role,
  m.role            AS membership_role
FROM `patman-inventory.patman_inventory.users` u
LEFT JOIN `patman-inventory.patman_inventory.memberships` m
  ON m.user_id         = u.user_id
 AND m.organization_id = u.organization_id
WHERE m.role IS NULL OR u.role != m.role;


-- ── Check 3 ─────────────────────────────────────────────────
-- Confirm no email collisions when email becomes nullable.
-- We only enforce uniqueness on `username`, not email.
-- Expected: shows informational duplicate emails (if any) — not blocking.
SELECT email, COUNT(*) AS n
FROM `patman-inventory.patman_inventory.users`
WHERE email IS NOT NULL AND email != ''
GROUP BY email
HAVING n > 1;


-- ── Check 4 ─────────────────────────────────────────────────
-- Confirm every membership references a real user AND a real org.
-- Uses explicit ON clauses because users.organization_id (legacy column)
-- still exists pre-migration and would make USING(organization_id) ambiguous.
-- Expected: 0 rows.
SELECT m.membership_id, m.user_id, m.organization_id
FROM `patman-inventory.patman_inventory.memberships` m
LEFT JOIN `patman-inventory.patman_inventory.users`         u ON u.user_id         = m.user_id
LEFT JOIN `patman-inventory.patman_inventory.organizations` o ON o.organization_id = m.organization_id
WHERE u.user_id IS NULL OR o.organization_id IS NULL;


-- ── Check 5 ─────────────────────────────────────────────────
-- Confirm the columns we intend to drop currently exist
-- (sanity check — protects against running on an already-migrated DB).
-- Expected: returns 3 rows (organization_id, role, updated_at-missing).
SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'users'
  AND column_name IN ('organization_id', 'role', 'updated_at', 'email');
