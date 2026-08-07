-- Migration: 001_orders_sku_resolution
-- Adds SKU resolution and ignore-tracking columns to the orders table.
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS is idempotent).
--
-- Run via gcloud (from the server/ directory):
--   bq query --project_id=patman-inventory --use_legacy_sql=false \
--     < migrations/001_orders_sku_resolution.sql
--
-- Or paste directly into BigQuery console → SQL editor.

ALTER TABLE `patman-inventory.patman_inventory.orders`
  ADD COLUMN IF NOT EXISTS is_ignored           BOOL,
  ADD COLUMN IF NOT EXISTS mapped_inventory_sku STRING,
  ADD COLUMN IF NOT EXISTS ignored_at           TIMESTAMP,
  ADD COLUMN IF NOT EXISTS ignored_by           STRING,
  ADD COLUMN IF NOT EXISTS mapped_at            TIMESTAMP,
  ADD COLUMN IF NOT EXISTS mapped_by            STRING;
