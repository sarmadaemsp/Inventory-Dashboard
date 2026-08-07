-- ============================================================
-- memberships — canonical DDL (post Phase-C migration)
-- ------------------------------------------------------------
-- Pure many-to-many link between users and organizations.
-- This table is now ONLY about org assignment — role lives on
-- `users.role` as a global field.
--
-- The JWT access token carries (user_id, organization_id, membership_id, role)
-- so every authenticated request is scoped to exactly one workspace.
-- `role` in the JWT comes from `users.role`, not this table.
--
-- LEGACY FIELD (slated for removal in Phase D):
--   `role` — was per-org role in the pre-Phase-C model. Kept until
--   Phase D so that any pre-Phase-C JWT still validates during the
--   transition window. New writes set this column equal to users.role.
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.memberships` (
  membership_id    STRING    NOT NULL,
  user_id          STRING    NOT NULL,
  organization_id  STRING    NOT NULL,
  is_active        BOOL      NOT NULL,
  created_at       TIMESTAMP,

  -- Legacy field (Phase D will drop this):
  role             STRING                              -- mirror of users.role during transition
);

-- Uniqueness contracts enforced by application code:
--   UNIQUE(membership_id)
--   UNIQUE(user_id, organization_id)   — one membership per user per org
