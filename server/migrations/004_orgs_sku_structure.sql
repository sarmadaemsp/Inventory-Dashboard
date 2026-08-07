-- ============================================================
-- 004_orgs_sku_structure — add sku_structure column to organizations
-- ------------------------------------------------------------
-- Phase 1 of the SKU Validation & Structure Management system.
-- Each organization optionally declares its SKU pattern (allowed
-- prefixes, separator, box/upc/part regex fragments). Stored as a
-- JSON-encoded string so the compiled regex can live alongside the
-- raw fragments without a second table.
--
-- Existing orgs get NULL → server keeps the legacy placeholder-only
-- undefined classification until an admin configures a structure.
-- ============================================================

ALTER TABLE `patman-inventory.patman_inventory.organizations`
  ADD COLUMN IF NOT EXISTS sku_structure STRING;
