-- ============================================================
-- inventory — canonical DDL
-- ------------------------------------------------------------
-- One row per inventory SKU per organization.
--
-- Centralized inventory calculations (inventoryMetricsService) treat:
--   remaining_stock  = GREATEST(quantity - effective_orders, 0)
--   phantom_units    = GREATEST(effective_orders - quantity, 0)
--   fulfilled_units  = LEAST(effective_orders, quantity)
--
-- Physical stock NEVER goes below zero by design. Phantom is a
-- warning metric only — it never reduces inventory.
--
-- "Undefined" classification: a row is undefined if ANY of
-- sku / upc / part_number are blank, 'NA', or 'N/A'.
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.inventory` (
  row_uid          STRING    NOT NULL,                -- canonical row tracker (UUID); replaces SKU for updates/deletes
  organization_id  STRING    NOT NULL,
  sku              STRING    NOT NULL,                -- operational identifier; CAN be duplicated across rows
  upc              STRING    NOT NULL,
  part_number      STRING,
  box_number       STRING,
  quantity         INT64     NOT NULL,                -- initial allocated quantity for this row
  date_added       STRING,                            -- free-form date string from upload (YYYY-MM-DD typical)
  notes            STRING,
  updated_at       TIMESTAMP
);

-- Uniqueness contracts enforced by application code:
--   UNIQUE(row_uid)
-- SKU is NOT unique — two rows in the same org may share a SKU (e.g.
-- different boxes/batches). Use row_uid as the mutation key.
