-- ============================================================
-- Async upload lifecycle (Phase A) — 2026-05-18
-- ============================================================
-- Adds the columns we need to track an upload across the new
-- non-blocking lifecycle:
--
--   accepted  → row created the moment the multipart parse finishes
--               and the HTTP request returns 202. Raw row writes have
--               NOT happened yet.
--   processing → background worker has picked up the buffered payload
--               and started running Phase 2-4 (key lookup + DML).
--   success / partial / failed → terminal states from the existing
--               pipelineRunner. Unchanged.
--
-- refreshed_at — TIMESTAMP set by the Cloud Tasks summary-refresh
-- worker (or the in-process fallback) AFTER the summary tables have
-- been rebuilt for this upload's organization. The frontend polls
-- /uploads/status/:upload_id and only stops showing "refreshing
-- analytics" once this column is non-NULL.
--
-- last_error — STRING capturing the failure message if Phase 2-4 or
-- the refresh hit an unhandled error. Used by the status endpoint to
-- surface a human-readable cause in the UI.
-- ============================================================

ALTER TABLE `patman-inventory.patman_inventory.inventory_uploads`
  ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_error   STRING;

ALTER TABLE `patman-inventory.patman_inventory.order_uploads`
  ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_error   STRING;

-- The `status` column already accepts free-text. The new intermediate
-- values 'accepted' and 'processing' do not require a schema change.
-- Frontend + repository code is the source of truth for the enum.
