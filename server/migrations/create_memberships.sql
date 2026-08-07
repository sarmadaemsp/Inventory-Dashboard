CREATE TABLE IF NOT EXISTS `patman_inventory.memberships` (
  membership_id   STRING    NOT NULL,
  user_id         STRING    NOT NULL,
  organization_id STRING    NOT NULL,
  role            STRING    NOT NULL,
  is_active       BOOL      NOT NULL,
  created_at      TIMESTAMP
)
CLUSTER BY user_id, organization_id;
