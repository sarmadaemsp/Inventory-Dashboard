-- Migration 001: Create memberships table
-- Run once in BigQuery console before deploying multi-tenant auth.
-- Dataset: patman_inventory

CREATE TABLE IF NOT EXISTS `patman_inventory.memberships` (
  membership_id   STRING    NOT NULL,
  user_id         STRING    NOT NULL,
  organization_id STRING    NOT NULL,
  role            STRING    NOT NULL,
  is_active       BOOL      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP
)
CLUSTER BY user_id, organization_id;

-- Verify
-- SELECT * FROM `patman_inventory.memberships` LIMIT 10;
