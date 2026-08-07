-- ============================================================
-- users — canonical DDL (post Phase-C migration)
-- ------------------------------------------------------------
-- Global user identity. No organization_id, no email.
-- ROLE IS GLOBAL — every user has exactly one role across the
-- entire platform. A user CANNOT be Admin in one org and View
-- in another.
--
--   - Organization membership is recorded ONLY in `memberships`.
--   - Role lives ONLY on `users.role` (3-tier: admin / user / view).
--
-- Login credential is `username` (globally unique, case-insensitive).
-- Display name is shown in UI; username is shown only in admin
-- contexts and JWT claims.
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.users` (
  user_id        STRING    NOT NULL,
  username       STRING    NOT NULL,
  password_hash  STRING    NOT NULL,                  -- bcrypt; legacy SHA-256 upgraded on next login
  display_name   STRING    NOT NULL,
  role           STRING    NOT NULL,                  -- {admin, manager, viewer} — global platform role
  is_active      BOOL      NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at     TIMESTAMP
);

-- Uniqueness contracts enforced by application code:
--   UNIQUE(user_id)
--   UNIQUE(LOWER(username))   — see usernameService.normalize() + isAvailable()
--
-- Role permission matrix (enforced by backend middleware + frontend hideRules):
--   admin   → full platform access (manage users, orgs, passwords; all operational actions)
--   manager → operational actions (uploads, shipped-SKU reassignment, edits)
--   viewer  → read-only (dashboards, exports/downloads; no writes)
