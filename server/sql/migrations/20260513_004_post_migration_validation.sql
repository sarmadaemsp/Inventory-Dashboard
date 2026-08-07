-- ============================================================
-- 20260513_004 — Post-migration validation
-- ------------------------------------------------------------
-- Run AFTER 20260513_003 completes successfully.
-- Confirms the canonical schema is in place and the runtime is
-- still consistent (no orphaned rows, no broken joins).
-- ============================================================

-- ── Check 1 ─────────────────────────────────────────────────
-- Confirm legacy columns are gone.
-- Expected: 0 rows.
SELECT column_name
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'users'
  AND column_name IN ('organization_id', 'role', 'email');


-- ── Check 2 ─────────────────────────────────────────────────
-- Confirm updated_at exists and is nullable.
-- Expected: 1 row, is_nullable = YES.
SELECT column_name, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'users' AND column_name = 'updated_at';


-- ── Check 3 ─────────────────────────────────────────────────
-- Re-run the membership coverage check. Every user must still
-- have at least one membership (this should not have changed).
-- Expected: 0 rows.
SELECT u.user_id, u.username
FROM `patman-inventory.patman_inventory.users` u
LEFT JOIN `patman-inventory.patman_inventory.memberships` m
  ON m.user_id = u.user_id AND m.is_active = TRUE
WHERE m.membership_id IS NULL;


-- ── Check 4 ─────────────────────────────────────────────────
-- Confirm the full final column set matches the canonical DDL.
-- Expected: exactly these 7 rows (in this order):
--   user_id        STRING    NO
--   username       STRING    NO
--   password_hash  STRING    NO
--   display_name   STRING    NO
--   is_active      BOOL      NO
--   created_at     TIMESTAMP NO
--   updated_at     TIMESTAMP YES
SELECT column_name, data_type, is_nullable
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'users'
ORDER BY ordinal_position;
