-- Migration 002: Inventory and orders schema alignment
-- New inventory schema: sku, upc, part_number, box_number, quantity, date_added, notes
-- New orders schema: order_id, order_date, sku, upc, quantity_sold, platform, source_file, shipped_from_box

-- If recreating inventory table from scratch:
CREATE OR REPLACE TABLE `patman_inventory.inventory` (
  organization_id STRING    NOT NULL,
  sku             STRING    NOT NULL,
  upc             STRING,
  part_number     STRING,
  box_number      STRING,
  quantity        INT64,
  date_added      STRING,
  notes           STRING,
  updated_at      TIMESTAMP
)
CLUSTER BY organization_id, sku;

-- If recreating orders table from scratch:
CREATE OR REPLACE TABLE `patman_inventory.orders` (
  organization_id  STRING    NOT NULL,
  order_id         STRING    NOT NULL,
  order_date       STRING,
  sku              STRING,
  upc              STRING,
  quantity_sold    INT64,
  platform         STRING,
  source_file      STRING,
  shipped_from_box STRING,
  created_at       TIMESTAMP
)
CLUSTER BY organization_id, order_date;

-- Upload log tables (create if missing):
CREATE TABLE IF NOT EXISTS `patman_inventory.inventory_uploads` (
  upload_id       STRING    NOT NULL,
  organization_id STRING    NOT NULL,
  user_id         STRING    NOT NULL,
  filename        STRING,
  row_count       INT64,
  status          STRING,
  created_at      TIMESTAMP
);

CREATE TABLE IF NOT EXISTS `patman_inventory.order_uploads` (
  upload_id       STRING    NOT NULL,
  organization_id STRING    NOT NULL,
  user_id         STRING    NOT NULL,
  filename        STRING,
  row_count       INT64,
  status          STRING,
  created_at      TIMESTAMP
);
