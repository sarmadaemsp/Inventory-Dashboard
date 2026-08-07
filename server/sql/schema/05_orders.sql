-- ============================================================
-- orders — canonical DDL (post Phase-D + shipped_sku consolidation)
-- ------------------------------------------------------------
-- One row per fulfilled order line per organization.
--
-- order_row_id is the canonical INTERNAL UID — used for PATCH/DELETE.
-- order_id is the EXTERNAL marketplace order number (Amazon, eBay, etc.).
--
-- shipped_sku is the OPERATIONAL OVERRIDE for fulfillment. It accepts
-- any of three operator-typed forms and SQL parses intent at query time
-- (see effectiveSkuSql in src/utils/skuPatterns.js):
--
--   "352"                              → box-only override
--                                        effective_sku = ARA352-{original-part}-{original-upc}
--   "ARA352"                           → box-only override (same as above)
--   "ARA352-4060537-037256090684"      → full SKU override (verbatim)
--
-- A row counts as "Shipped Wrong Part Number" when the stored
-- shipped_sku has a part-UPC suffix that differs from the ordered
-- SKU's part-UPC suffix — the operator shipped a different part.
--
-- mapped_inventory_sku is an alternate manual mapping used to
-- rescue an order whose feed SKU doesn't match any inventory row
-- even after the shipped_sku override is applied.
--
-- LEGACY COLUMNS REMOVED:
--   is_ignored, ignored_at, ignored_by — replaced by hard deletes (Phase D)
--   shipped_from_box, shipped_sku_override — consolidated into shipped_sku
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.orders` (
  order_row_id         STRING    NOT NULL,             -- INTERNAL UID: row tracker for API updates/deletes
  organization_id      STRING    NOT NULL,
  order_id             STRING,                          -- EXTERNAL marketplace order ID
  order_date           STRING    NOT NULL,             -- YYYY-MM-DD; queries use SAFE_CAST(order_date AS DATE)
  sku                  STRING    NOT NULL,             -- feed SKU; may be overridden by shipped_sku
  quantity_sold        INT64     NOT NULL,
  platform             STRING    NOT NULL,
  shipped_sku          STRING,                         -- OPERATIONAL OVERRIDE: box digits OR full alternate SKU
  mapped_inventory_sku STRING,                         -- alternate manual mapping (rescue path)
  uploaded_by          STRING,                         -- user_id of uploader
  created_at           TIMESTAMP,                      -- upload timestamp
  mapped_at            TIMESTAMP,
  mapped_by            STRING
);

-- Uniqueness contracts enforced by application code:
--   UNIQUE(order_row_id)
