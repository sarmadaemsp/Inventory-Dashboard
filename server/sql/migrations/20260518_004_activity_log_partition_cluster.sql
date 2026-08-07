-- ============================================================
-- M4 — activity_log partition + cluster migration
-- ============================================================
-- The activity_log table has no partitioning or clustering today.
-- Every `getRecent(organizationId, limit)` query scans the full
-- physical table even though it only ever returns the most recent
-- N rows for one org.
--
-- After this migration:
--   PARTITION BY DATE(created_at)        — recent-rows queries scan
--                                          only the latest partition
--   CLUSTER BY organization_id, action_type
--                                        — org-scoped slice within
--                                          each partition
--
-- Same zero-downtime CREATE-then-RENAME pattern as
-- 20260518_003_inventory_orders_partition_cluster.sql.
-- ============================================================


-- ── STEP 1 — Build partitioned + clustered activity_log_new ────
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.activity_log_new`
(
  activity_id     STRING    NOT NULL,
  organization_id STRING    NOT NULL,
  user_id         STRING,
  action_type     STRING    NOT NULL,
  entity_type     STRING    NOT NULL,
  description     STRING    NOT NULL,
  created_at      TIMESTAMP NOT NULL
)
PARTITION BY DATE(created_at)
CLUSTER BY organization_id, action_type
AS
SELECT
  activity_id, organization_id, user_id, action_type, entity_type,
  description, created_at
FROM `patman-inventory.patman_inventory.activity_log`;


-- ── STEP 2 — Verify row count (run manually before STEP 3) ─────
--   SELECT 'orig' AS t, COUNT(*) AS n
--   FROM `patman-inventory.patman_inventory.activity_log`
--   UNION ALL
--   SELECT 'new', COUNT(*)
--   FROM `patman-inventory.patman_inventory.activity_log_new`;


-- ── STEP 3 — Atomic rename (after STEP 2 verifies clean) ───────
-- ALTER TABLE `patman-inventory.patman_inventory.activity_log`     RENAME TO activity_log_old;
-- ALTER TABLE `patman-inventory.patman_inventory.activity_log_new` RENAME TO activity_log;


-- ── STEP 4 — Drop _old after 24h grace window ──────────────────
-- DROP TABLE `patman-inventory.patman_inventory.activity_log_old`;
