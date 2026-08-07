-- ============================================================
-- organizations — canonical DDL
-- ------------------------------------------------------------
-- One row per tenant. Identity columns are organization_id (uuid)
-- and slug (human-friendly URL identifier, unique).
--
-- All other rows in every other table reference organization_id.
-- ============================================================

-- created_at is NOT NULL but has no column-level DEFAULT — BigQuery rejects
-- DEFAULT CURRENT_TIMESTAMP() at parse time in some project configurations.
-- organizationsRepository.insert() always supplies CURRENT_TIMESTAMP() in the
-- VALUES list, so the column is effectively always populated at write time.
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.organizations` (
  organization_id  STRING    NOT NULL,
  slug             STRING    NOT NULL,
  display_name     STRING    NOT NULL,
  is_active        BOOL      NOT NULL,
  -- JSON-encoded SkuStructure (see server/src/utils/skuValidator.js). NULL = no
  -- structure validation configured (back-compat: only the empty / "NA" / "#N/A"
  -- placeholder check classifies an inventory row as undefined). When populated,
  -- the compiled regex is also embedded inside the JSON so query-time SQL does
  -- not need to recompile per request.
  sku_structure    STRING,
  created_at       TIMESTAMP NOT NULL
);

-- Uniqueness contracts enforced by application code (BigQuery does not enforce):
--   UNIQUE(organization_id)
--   UNIQUE(slug)
