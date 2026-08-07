-- ============================================================
-- activity_log — canonical DDL
-- ------------------------------------------------------------
-- Append-only audit trail of user-initiated mutating actions.
-- Logging failures are non-fatal: activityRepository.log() swallows
-- errors so they never block the main operation.
--
-- action_type values (current):
--   upload_inventory, upload_orders,
--   edit_inventory,   delete_inventory,
--   edit_order,       delete_orders,
--   reassign_fulfillment_sku
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.activity_log` (
  activity_id      STRING    NOT NULL,
  organization_id  STRING    NOT NULL,
  user_id          STRING,                            -- nullable: some actions are system-initiated
  action_type      STRING    NOT NULL,
  entity_type      STRING    NOT NULL,                -- inventory | orders | users | ...
  description      STRING    NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- Recommended partitioning (manual — not enforced by DDL):
--   PARTITION BY DATE(created_at)
--   CLUSTER BY organization_id, action_type
