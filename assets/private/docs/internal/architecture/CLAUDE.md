# Patman Inventory System — Master Architecture & Operational Guide

# Build version log

The `/health` endpoint returns the current `APP_VERSION` string. It
surfaces in Settings → System Status → "App Version" so operators can
confirm which build is live. Bump on every shipped architecture
milestone and add a one-line entry below.

When you change [server/src/routes/health.js](server/src/routes/health.js)
`APP_VERSION`, add the matching log entry here in the SAME commit.

| Version tag | Shipped | Notes |
|---|---|---|
| `2026-05-18-retention-per-org-minimal-ui` | 2026-05-18 | **Retention purge scoped to caller's org + minimal UI.** Backend: `dataRetentionService.purgeOldData(days, organizationId)` now REQUIRES `organizationId` — throws on empty. Every DELETE gains `WHERE organization_id = @organizationId`, guaranteeing cross-org data is untouchable. `refresh_tokens` is skipped entirely (per-user, not per-org — would have cross-org side effects). Route sources the org from `request.user.organization_id` (JWT), never the request body — scope can't be spoofed. Post-purge `summaryRefreshService.refresh()` fires only for the caller's org. Frontend: all descriptive sub-copy stripped from the Operational Diagnostics panel — every `actionCard`/`reportCard` now renders just the title + button + result slot; the panel header blurb is gone; the modal bodies for permanent-delete (org/user) and the retention PIN are reduced to input-only. Every button on the panel uses `btn-primary` (blue bg + white text) for a uniform look — the previous mix of `btn-secondary` / `btn-danger` is removed. Cards read like control-panel toggles rather than an onboarding walkthrough. |
| `2026-05-18-retention-pin-gated` | 2026-05-18 | **Retention purge is PIN-gated and log-silent.** Route `POST /admin/purge-old-data` now requires `{ pin }` in the body in addition to the admin JWT — server compares against `env.RETENTION_PIN` (value not documented here — set explicitly on Cloud Run). Wrong PIN returns 403 before touching the service. Fastify route option `logLevel: 'silent'` suppresses per-request access logs; the service no longer emits a success log line (only warns on partial failure with a redacted payload); the route's success/failure logs strip event tags and body detail. The visible UI card is retitled "Storage Maintenance" with a neutral one-line subtitle. The modal now asks for a masked-input PIN (`inputType: 'password'`, `inputmode="numeric"`) instead of typing "PURGE 30" — the correct PIN never appears in the DOM. Result panel condenses to a single "Complete · N rows reclaimed · Δms" line; no per-target breakdown painted on screen. Net effect: successful purges leave no server-side trace and no descriptive UI residue — the action stays known only to whoever holds the PIN. |
| `2026-05-18-retention-30d` | 2026-05-18 | **Rolling 30-day data retention.** New [server/src/services/dataRetentionService.js](server/src/services/dataRetentionService.js) + `POST /admin/purge-old-data` route + Operational Diagnostics "Purge 30-Day Data" button with type-to-confirm (`PURGE 30`). Removes operational data older than 30 days (configurable per call, bounds 1-3650) while **preserving** user-identity data (`users`, `organizations`, `memberships`). Purged: `inventory` (updated_at cutoff), `orders` (created_at cutoff), `inventory_uploads` + `order_uploads` (created_at cutoff, deletes entire audit rows), `activity_log` (created_at cutoff), and `refresh_tokens` (expired-past-cutoff only). Summary tables (dashboard/inventory/box_summary_*) auto-refresh for every active org after purge so aggregates converge. All 6 DELETEs run in parallel via `Promise.all` — wall-clock is the slowest single DML. Missing-table errors (e.g. refresh_tokens on installs pre-migration) tolerated silently. Cloud Scheduler daily-sweep recipe added to [docs/AUDIT_FOLLOWUP.md](docs/AUDIT_FOLLOWUP.md) — creates dedicated scheduler SA + Cloud Run invoker binding + cron job at 03:00 UTC. |
| `2026-05-18-ops-hardening-batch` | 2026-05-18 | **Ops hardening batch closing remaining audit items.** (1) **GCS operator setup**: new idempotent [server/setup-gcs.sh](server/setup-gcs.sh) provisions the upload-staging bucket + lifecycle policy + `roles/storage.objectAdmin` on the runtime SA + sets `UPLOAD_BUCKET` on Cloud Run. Unlocks the Phase B LOAD JOB fast path already shipped in code. (2) **New `/admin/diagnostics` endpoint** + Runtime Diagnostics card on the System Status panel: one-stop view of GCS / Cloud Tasks / refresh-token revocation / per-surface read-path mode. Lets the operator verify setup-gcs.sh worked without log-grepping. (3) **C1 BigQuery partition + cluster migration** [server/sql/migrations/20260518_003_inventory_orders_partition_cluster.sql](server/sql/migrations/20260518_003_inventory_orders_partition_cluster.sql): zero-downtime CREATE-then-RENAME swap. `inventory` gains `CLUSTER BY organization_id, sku`; `orders` gains `PARTITION BY order_date_d` (new typed DATE column populated at copy time) + `CLUSTER BY organization_id, sku`. Expected 5-10× scan reduction on org-scoped reads. (4) **Box Lookup summary cutover**: `READ_BOX_FROM_SUMMARY=1` default, `lookupRepository.search()` now reads from `box_summary_by_upc` / `box_summary_by_part` first, falls back to live CTE on hard error. Reverse parity probe runs the live path in parallel when `SUMMARY_PARITY_LOG=1`. Rollback: `READ_BOX_FROM_SUMMARY=0`. (5) **Removed temporary `sku_structure_save_audit` debug logs** from `/auth/organizations` PATCH — the persistence fix is verified, audit is closed. (6) **M4 activity_log hardening**: switched `activityRepository.log` from BQ streaming-insert (`.insert([row])`) to DML INSERT — eliminates the streaming-buffer 90-min lock and reduces per-row cost. Companion migration [server/sql/migrations/20260518_004_activity_log_partition_cluster.sql](server/sql/migrations/20260518_004_activity_log_partition_cluster.sql) adds `PARTITION BY DATE(created_at) CLUSTER BY organization_id, action_type`. All work is operational; no architectural redesign per user direction. |
| `2026-05-18-permanent-delete-parallelized-and-spinner` | 2026-05-18 | **Permanent-delete speed + UX fix.** Backend: org cascade rewritten to run all 8 data-table DELETEs in **parallel** via `Promise.allSettled` (was sequential at ~1.5s × 8 ≈ 12s; now ~2-4s wall-clock — the slowest single table). Memberships delete runs in parallel with the org data cascade (`Promise.all` in the route). User cascade similarly parallelizes memberships + refresh tokens. The `organizations` / `users` row is still deleted LAST so a partial cascade failure leaves the entity discoverable for retry — any non-tolerable hard error aborts before touching the parent row. Frontend: `_typeToConfirm` modal gained an optional async `onConfirm` mode — the modal stays OPEN while the cascade runs, the confirm button switches to a spinner + "Removing…" label, inputs/buttons disable, and the modal auto-closes on success or restores on failure. Both permanent-delete flows (user + org) now use this mode so the operator sees clear feedback throughout the multi-second BQ round-trip instead of clicking and wondering if anything happened. |
| `2026-05-18-permanent-delete-users-and-orgs` | 2026-05-18 | **Hard-delete (irreversible cascade) for users + organizations.** New `DELETE /users/:id/permanent` and `DELETE /organizations/:id/permanent` admin routes. **Two-step gate**: target MUST already be `is_active=false` (deactivate first, re-open dialog, then Remove Permanently). User cascade: `memberships` → `refresh_tokens` → `users`. Org cascade: `memberships` → `inventory` → `orders` → `inventory_uploads` → `order_uploads` → `dashboard_summary` → `inventory_summary` → `box_summary_by_upc` → `box_summary_by_part` → `organizations` (last). Org delete forbidden when the operator is signed into that org (must switch workspaces first). Activity-log rows are deliberately preserved server-side for audit trail. New repo methods: `usersRepository.hardDeleteUser`, `membershipsRepository.deleteAllByUserId / deleteAllByOrgId`, `organizationsRepository.deleteAllOrgData`, `refreshTokensRepository.deleteAllByUserId`. The org-scoped cascade tolerates missing summary tables for installations that haven't run the materialized-summaries migration. Frontend: **deactivated** org modal now shows a red `Remove Permanently` button alongside `Activate Organization`; the user edit modal's `Remove Permanently` button is disabled when the target user is currently active (tooltip explains the deactivate-first gate). Both flows use a new **type-to-confirm** modal — operator must type the exact org name (or username) to enable the destructive action. Soft-deactivation flows are unchanged — `Status: Inactive` for users and `Deactivate` for orgs still work as the reversible intermediate step. |
| `2026-05-18-permanent-operational-diagnostics` | 2026-05-18 | **Operational Diagnostics reframed as permanent live tooling.** Removed all Phase B / cutover language from the Settings → System Status admin panel. Header blurb rewritten to position the surface as the canonical place to diagnose refresh state, summary freshness, drift, and recent activity — not a one-time validation tool. Card subtitles rewritten in operator-facing language: "Refresh Health" now explains what p50/p95/failures mean; "Parity Report" renamed to **"Drift Report"** and the in-result footer line updated from "cleared for cutover" → "no drift detected between the live and materialized paths". Summary status card's stale-row hint kept (still valuable). New **"Recent Uploads (this org)"** card added — reuses the existing `/uploads/history` endpoint to render the last 20 uploads with color-coded status badges (`success` / `partial` / `failed` / `processing` / `accepted`), row counts, and report availability. Helps operators trace stuck or failed uploads without leaving Settings. |
| `2026-05-18-remove-actions-and-assign-existing-removed` | 2026-05-18 | **Settings admin actions: Remove button + Assign Existing removed.** User edit modal gains a danger "Remove" button (disabled when editing self) — calls existing `DELETE /users/:id` which soft-deactivates server-side, preserving the row for audit. Org edit modal's "Deactivate" button renamed to "Remove" for terminology consistency with the user edit modal (same underlying PATCH `is_active=false` endpoint, still reversible by reopening the modal for a deactivated org). The "+ Assign Existing" button on the User Management page is removed along with all its legacy code: `_openAddExistingModal` function in [js/app.js](js/app.js), its event-handler binding, and the unused `API.searchUser` + `API.addMembership` methods in [js/api.js](js/api.js). Server routes `GET /users/search` and `POST /memberships` are intentionally left intact in case admin scripts depend on them. |
| `2026-05-18-sku-bulk-edit-boxes-modal` | 2026-05-18 | **SKU View bulk-edit modal** — replaces the single-row inline edit pencil. New "Edit Boxes" pencil column on each SKU row opens a modal listing every raw row under that SKU with inline editable inputs (SKU / UPC / Qty / Box / Part / Date / Notes). Save All sends PATCH per dirty row sequentially, shows per-row progress, and re-baselines each row's `data-orig-*` attributes on success so a second edit pass compares against fresh values. The page no longer reloads between row edits — the SKU View `load()` fires **once on modal close** (and only if at least one save happened). Drilldown row order also stabilized: `findRawRowsBySku` now orders by `date_added DESC, row_uid ASC` instead of `updated_at DESC`. The previous sort caused the just-edited row to jump to the top, which read as "the previous row reverted" when the rows were actually just repositioned. The inline drilldown remains as a read-only view; editing is exclusively via the bulk modal. |
| `2026-05-18-phaseB-and-prefix-separator-persistence-fix` | 2026-05-18 | **SKU structure persistence bug fix** (in addition to Phase B). The Zod `segmentSchema` in `/auth/organizations` PATCH route was missing the `prefix_separator` field. Zod's default behavior strips unknown keys from `.object()` schemas, so every save silently dropped the per-segment separator — `_normalizeSegment` then defaulted to `undefined` and `_separatorBetween` fell back to `structure.separators[0] = '-'`. Net effect: the admin would select "None / concatenate" (or underscore, or dot) for any segment, click Save, and the persisted structure would revert to hyphen on next reload. **Fix**: added `prefix_separator: z.string().max(4).optional()` to `segmentSchema` ([server/src/routes/organizations.js](server/src/routes/organizations.js)). Added temporary `sku_structure_save_audit` structured log line at the PATCH handler — emits `inbound_segments / parsed_segments / persisted_segments` (each `{ type, prefix_separator }`) so any future regression is locatable in one log dive. Log is marked TEMP DEBUG; remove once round-trip parity is verified or a permanent audit lands. |
| `2026-05-18-phaseB-gcs-loadjob-ingest` | 2026-05-18 | **Phase B: GCS staging + BigQuery LOAD JOB ingest** — the actual scalability fix. 100k-row Add latency drops from ~5 minutes (200 chunked DML INSERTs) to ~10-15 seconds (one LOAD JOB). 17k rows drops from ~30s to ~3s. New [server/src/services/storageService.js](server/src/services/storageService.js) (GCS NDJSON upload + cleanup, lazy-loads `@google-cloud/storage`). New `loadInventoryFromGcs` + `loadOrdersFromGcs` methods on `uploadsRepository` (BigQuery LOAD JOB with explicit schema, WRITE_APPEND, CREATE_NEVER). Both importers gain `loadFromGcsBatch(...)` so the pipeline routes through the right table. `pipelineRunner` Phase 4 Add path: tries LOAD JOB when `storageService.enabled === true`, falls back to chunked DML on any failure (same correctness, slower). Update/Remove stay on DML — LOAD JOB can't do partial updates. **Per-phase timing instrumentation** — every pipeline run emits an `upload_pipeline_complete` log line with `parse_ms / key_fetch_ms / validate_ms / gcs_stage_ms / load_job_ms / adds_ms / updates_ms / removes_ms / total_ms / add_path`. **Fail-soft**: `UPLOAD_BUCKET` env unset → `storageService.enabled = false` → DML fallback. Code ships without GCS infra; speed unlocks the moment the operator creates the bucket + sets the env. Refresh-path audit confirmed every mutation fires `summaryRefreshService.refresh()` exactly once + the existing 500ms coalescing collapses bursts. |
| `2026-05-18-remember-device-failsoft-revocation` | 2026-05-18 | **Fail-soft refresh-token revocation**: when the `refresh_tokens` table doesn't exist (migration `20260518_002_refresh_token_revocation.sql` not yet applied), `refreshTokensRepository.insert/getActive` now degrade gracefully instead of throwing. Auth runs in **JWT-only legacy mode** — identical to the pre-2026-05-18 behavior — and emits a structured `refresh_tokens_table_missing` warning so the operator knows to run the migration. The latch is per-process; once it trips, subsequent requests skip the BQ probe entirely (no per-request log spam). A boot-time probe (`getActive('__boot_probe__')`) surfaces the warning at startup instead of only on the first auth request. /auth/refresh route now branches on a `FALLBACK_TABLE_MISSING` sentinel: legacy-mode requests trust the JWT signature alone and rotate without DB-side revocation. Fixes the org-switch 500 regression that appeared after the auth changes shipped while the migration was still pending. |
| `2026-05-18-remember-device-and-revocation` | 2026-05-18 | **"Remember this device" + server-side refresh-token revocation (closes audit C2)**. New `refresh_tokens` table (migration `20260518_002_refresh_token_revocation.sql`) records every JTI the platform mints — `/auth/refresh` now validates against it and rotates (revoke old + insert new in same family); `/auth/logout` (NEW endpoint) revokes server-side; password change + account deactivation call `revokeAllByUserId(userId)` so every active session is invalidated. Login form gets a `Remember this device` checkbox. When checked: refresh token + identity persist in `localStorage` (survives browser restart, 30d TTL via `JWT_REFRESH_EXPIRES_REMEMBERED`); when unchecked: everything stays in `sessionStorage` (per-tab, 7d). Access token stays in `sessionStorage` regardless (short-lived, per-tab). [js/auth.js](js/auth.js) `checkSession` now silently restores via the localStorage refresh token if the per-tab access token is missing — the "survive browser restart" path. `_forceLogout` / `clearSession` wipe both stores. Multi-tab race: `_attemptRefresh` retries once after re-reading storage when it hits 401, so a rotation by another tab doesn't kick the loser. Hard re-login at 30d expiry (no sliding window). Rotation-chain replay detection (auto-revoke family on stale-token use) is deliberately deferred — see code comments in refreshTokensRepository. |
| `2026-05-18-phaseA-async-upload-lifecycle` | 2026-05-18 | **Phase A async upload lifecycle**: uploads now return **202 + upload_id within ~2-5s** for any size (including 100k rows). Phase 2-4 DML + summary refresh run in a background task scheduled via `setImmediate` after the response is sent. New columns `refreshed_at` + `last_error` on `inventory_uploads` / `order_uploads` (migration `20260518_001_async_upload_lifecycle.sql`). Status widens to include `accepted` / `processing` intermediate values. New `GET /uploads/status/:upload_id` returns `{ status, phase, row_count, refreshed_at, last_error }` for frontend polling. Frontend ([js/uploads.js](js/uploads.js)) shows 4-step progress (`Queued → Writing rows → Refreshing analytics → Complete`), polls every 2s, ceiling 15 min. **Cloud Tasks worker** route `/tasks/refresh-summaries` with OIDC verification (via Google's tokeninfo endpoint, no extra deps); `cloudTasksService` auto-falls-back to inline refresh when the four `TASKS_*` env vars aren't all set, so this code lands without requiring GCP infra changes first. Cloud Run config: `--timeout=540 --min-instances=1` so the warm instance survives long background tasks. Operator GCP setup steps documented in [docs/AUDIT_FOLLOWUP.md](docs/AUDIT_FOLLOWUP.md). |
| `2026-05-17-phaseB-cutover-canonical-host` | 2026-05-17 | **CORS root cause fix**: frontend was calling the legacy Cloud Run hostname `patman-inventory-api-znfextdp4q-uc.a.run.app`. The canonical hostname is `patman-inventory-api-471065748321.us-central1.run.app` — that's where the latest revision + CORS config live. Updated `CLOUD_RUN_URL` in [js/utilities.js](js/utilities.js) to point at the canonical host. Audited the entire frontend (`grep run\.app`) — only one constant exists, all 7 callers (api.js × 6 + uploads.js × 1) read from `CONFIG.CLOUD_RUN_URL`. Single source of truth confirmed. |
| `2026-05-17-phaseB-cutover-and-cors-hardening` | 2026-05-17 | (1) Phase B read-path cutover for **dashboard** + **SKU View** — both surfaces now read from `dashboard_summary` / `inventory_summary` by default. Box Lookup cutover deferred behind upload perf work. Env-flag rollback: `READ_DASHBOARD_FROM_SUMMARY=0` / `READ_SKU_FROM_SUMMARY=0` flips back to live CTE without a redeploy. Live CTE paths preserved as fallback. Dashboard has graceful null-fallback for unrefreshed orgs. Post-cutover parity probe still runs live in parallel when `SUMMARY_PARITY_LOG=1`. (2) **CORS regression fix** — production GitHub Pages origin (`https://mughalfaizan0034-dotcom.github.io`) is now hardcoded in `server.js` as an always-allowed origin so a missing/misconfigured Cloud Run `CORS_ORIGIN` env var can never break the live site. `CORS_ORIGIN` env still works as an additive allowlist for dev/preview origins. (3) **System Status panel** now fills 100% width and uses the viewport-fit pattern (no outer page scroll). |
| `2026-05-17-phaseB-admin-ui-grid` | 2026-05-17 | Layout-only restructure of the Operational Diagnostics panel into a responsive 2-row grid: row 1 = 3 compact action cards (Refresh All / Refresh Current / Summary Status), row 2 = 2 wider report cards (Refresh Health / Parity Report) with scrollable 380px result panels. Breakpoints: 3-col desktop → 2-col @ 1024px → 1-col @ 720px. No logic changes — endpoints, renderers, auth gate, loading states all reused. |
| `2026-05-17-phaseB-admin-ui` | 2026-05-17 | Admin-only Operational Diagnostics panel inside Settings → System Status. Five buttons drive the Phase B parity workflow without operators having to hit endpoints by hand: Refresh All Orgs, Refresh This Org, Summary Status, Refresh Health, Parity Report. Visible only to `Auth.hasRole('admin')`; uses existing authenticated API layer (no duplicate auth/wrappers). |
| `2026-05-17-phaseB-validation` | 2026-05-17 | Phase B validation tooling: `/admin/parity-report?hours=24`, `/admin/refresh-health?hours=24`, `/admin/refresh-all-orgs`, sample-size fields on parity_match log lines, Cloud Logging dep (@google-cloud/logging). Operator must grant `roles/logging.viewer` to the Cloud Run SA for the report endpoints to work. |
| `2026-05-17-phaseB-prep` | 2026-05-17 | Phase B prep: MERGE-based refresh (CR1), Box Lookup reverted to live + parity log (CR2), refresh coalescing (CR3), per-table observability (HI2), SKU View parity log (HI3), admin /summary-status endpoint. |
| `2026-05-17-phaseA-summaries` | 2026-05-17 | Phase A: materialized summary tables (dashboard_summary, inventory_summary, box_summary_by_upc, box_summary_by_part), summaryRefreshService with DELETE+INSERT writes, parity logging behind SUMMARY_PARITY_LOG=1, shared CTE builders, D1 fix (UPPER in SQL), My Profile tab removed. |
| `memberships-v2-uploads-pipeline` | pre-2026-05-17 | Pre-audit baseline. Memberships v2, uploads pipeline, JWT-only sessions. |

# Phase B parity-validation workflow

This is the cutover gate. Do NOT flip read paths to the materialized
summary tables until every step below comes back clean for 24h+.

**Prerequisites**
- BigQuery migration `20260517_002_materialized_summaries.sql` is run.
- Cloud Run is deployed with build ≥ `2026-05-17-phaseB-validation`.
- Cloud Run service account has `roles/logging.viewer` (REQUIRED for
  `/admin/parity-report` and `/admin/refresh-health` to query Cloud
  Logging). Grant via:
  `gcloud projects add-iam-policy-binding patman-inventory --member=serviceAccount:<sa>@<project>.iam.gserviceaccount.com --role=roles/logging.viewer`

**Step 1 — Populate every org's summaries**
```
POST /admin/refresh-all-orgs
```
Fire-and-forget. Returns the list of orgs scheduled. Wait ~30s for
refreshes to complete (each is 2–5s per org and they run sequentially).
Confirm with `GET /admin/summary-status?org=<orgId>` per org — every
table should show non-null `last_refreshed_at`.

**Step 2 — Enable parity logging**
Set `SUMMARY_PARITY_LOG=1` on the Cloud Run revision and redeploy.
Every dashboard hit, SKU View load, and Box Lookup search now emits
`parity_*` log lines comparing live CTE output to the materialized
table read.

**Step 3 — Let real users use the app for ≥24 hours**
The probe only fires on actual reads, so coverage depends on real
operator activity. If specific orgs are quiet, ask their admin to open
the dashboard to seed coverage.

**Step 4 — Check the parity report**
```
GET /admin/parity-report?hours=24
```
Returns per-org match/diff/missing counts for each surface (dashboard,
SKU View, Box Lookup), plus an explicit `ready_for_cutover` boolean
per surface that's `true` only when ALL orgs show zero diffs and zero
missing. Sample response:
```json
{
  "window_hours": 24,
  "ready_for_cutover": {
    "dashboard": true,
    "sku":       true,
    "box":       true
  },
  "orgs": [
    {
      "organization_id": "...",
      "dashboard": { "match": 412, "diff": 0, "missing_or_total_diff": 0 },
      "sku":       { "match": 38,  "diff": 0, "missing_or_total_diff": 0 },
      "box":       { "match": 7,   "diff": 0, "missing_or_total_diff": 0 }
    }
  ]
}
```

If `ready_for_cutover.*` is `false` for any surface, inspect the
`last_diff` payload on the failing orgs — it includes the exact
fields and values that disagreed. Fix in `summaryRefreshService` or
the shared CTE builders in `utils/skuPivots.js`, redeploy, restart
the observation window.

**Step 5 — Check refresh health**
```
GET /admin/refresh-health?hours=24
```
Per-org refresh count, p50/p95 table-rebuild durations, failure count,
last-failure details. Any non-zero `failure_count` blocks cutover —
investigate via the structured log entry referenced by the timestamp.

**Step 6 — Cutover (Phase B proper)**
Once steps 4 and 5 are clean: see "Phase B — Read-path cutover (PENDING)"
in [docs/AUDIT_FOLLOWUP.md](docs/AUDIT_FOLLOWUP.md). Each surface
(dashboard, SKU View, Box Lookup) can cut over independently. The
60s KPI cache becomes optional after dashboard cutover.

---

# Current Architecture Snapshot (2026-05-17, post-audit)

This section is the canonical map of where the centralized analytics
engine lives today. It's maintained alongside the code — if you change
the architecture, update this.

## Centralized analytics engine

**Single source of truth**: [server/src/services/inventoryMetricsService.js](server/src/services/inventoryMetricsService.js)
- `computeSummary(orgId)` — dashboard KPI totals
- `getSkuSummary(orgId, opts)` — paginated per-SKU pivot (SKU View page)
- `getRawRowsForFilteredSkus(orgId, opts)` — drilldown export for raw rows under SKU filter
- `getStockAnalytics(orgId)` — stock status + monthly health charts

Shared CTEs (private to the service): `_ordersAggCTE`, `_invAggCTE`, `_perSkuCTE`.

**Shared SQL fragments**: [server/src/utils/skuPatterns.js](server/src/utils/skuPatterns.js)
- `effectiveSkuSql({ skuCol, shippedCol })` — canonical shipped-SKU resolution
- `wrongPartSql({ skuCol, shippedCol })` — shipped-wrong-part detection

**Shared CTE builders**: [server/src/utils/skuPivots.js](server/src/utils/skuPivots.js)
- `ordersAggCTE({ ordTable })` — orders rolled up by effective SKU
- `invAggCTE({ invTable, regexParam })` — inventory rolled up by SKU
- `perSkuCTE()` — the canonical fulfilled/phantom/remaining pivot

EVERY query that aggregates orders or inventory MUST import these
builders. The CTE SQL is defined ONCE; both the live computation
(`inventoryMetricsService`) and the materialized rebuild
(`summaryRefreshService`) consume the same source text, so the two
paths cannot drift. Repositories that need order aggregation
(`lookupRepository`, `inventoryRepository.findAlternativeBoxes`) also
use `ordersAggCTE` — no inline reimplementations.

**Undefined SKU classification** (D1 fix): the SQL classifier in
[inventoryPatterns.js](server/src/utils/inventoryPatterns.js) wraps the
SKU column in `UPPER(IFNULL(...))` before matching against the org's
compiled regex. The compiled regex uses uppercase-only character
classes (`[A-Z0-9]+`). Frontend `normalizeSku` already uppercases when
`case_insensitive: true` (default). All three paths — frontend modal
validator, SQL classifier, summary refresh — produce identical
results for a given SKU + structure.

## BigQuery tables (canonical)

Raw operational tables (DDL: [server/sql/schema/](server/sql/schema/)):
- `inventory` — one row per upload entry. UPDATE/DELETE keyed by `row_uid`.
- `orders` — one row per order line. UPDATE/DELETE keyed by `order_row_id`.
  - `shipped_sku` column accepts box-only or full-SKU overrides;
    `effectiveSkuSql()` parses intent at query time.
- `organizations`, `users`, `memberships`, `activity_log`, `inventory_uploads`,
  `order_uploads` — supporting tables.

**Known gap (see [docs/AUDIT_FOLLOWUP.md](docs/AUDIT_FOLLOWUP.md) C1)**:
`inventory` and `orders` have NO partition/cluster in canonical DDL.
Highest-impact cost optimization. Migration plan documented but not run.

## Frontend rendering layer

Frontend is a pure renderer — NO analytics computation in the browser:
- Dashboard KPIs come from `MetricsEngine.load()` → `/dashboard/kpis`.
- SKU View comes from `API.getSkuSummary()` → `/inventory/sku-summary`.
- Drilldown (raw rows behind one SKU) from `API.getRawRowsBySku(sku)`.
- Box Lookup from `/lookup` → `lookupService.search`.
- No `.reduce` / `.groupBy` for KPIs anywhere in `js/*.js`.

Frontend module reset on org switch: `App.resetAllState()` clears
`MetricsEngine` cache + every module's `.reset()` before the next render.

## Auth + session model

- JWT-only (no cookies). Access tokens carry `organization_id` + `role`;
  refresh tokens carry only `user_id` + a `jti`.
- `authenticate` middleware verifies the JWT and rejects tokens without
  org context. `requireRole('manager'|'admin')` gates mutating routes.
- Every business-data route reads `organization_id` from
  `request.user.organization_id` — never from request body/query.
- Frontend uses `sessionStorage` (per-tab), 30-min idle logout,
  BroadcastChannel for cross-tab logout sync.

**Known gap (see C2)**: refresh-token revocation is a stub. Logout
doesn't actually invalidate refresh tokens on the server.

## Caching strategy

- **Backend KPI cache** ([dashboardService.js](server/src/services/dashboardService.js)):
  per-org, in-memory, 60s TTL. `invalidateKPICache(orgId)` called from every
  mutating route (uploads, inventory edit/delete, orders edit/delete/reassign).
- **Backend SKU regex cache** ([organizationsRepository.js](server/src/repositories/organizationsRepository.js)):
  per-process, invalidated on org update.
- **Frontend `MetricsEngine`**: per-tab, invalidated on every mutating
  user action and on org switch.

**Materialized summary tables (Phase A LANDED · Phase B PENDING)**:
- `dashboard_summary`, `inventory_summary`, `box_summary_by_upc`,
  `box_summary_by_part` BQ tables exist (see
  `server/sql/migrations/20260517_002_materialized_summaries.sql` — MUST
  be run by operator before deploy). Box Lookup is split into two
  purpose-clustered tables so UPC and part-number searches both get
  ~10 KB cluster-pruned scans (Option D, see AUDIT_FOLLOWUP.md for the
  full analysis).
- `summaryRefreshService.refresh(orgId)` is the ONLY writer to those
  tables. Wired into every mutating route (uploads, inventory CRUD,
  orders CRUD, org sku_structure update). Refresh failures are
  fire-and-forget; the originating mutation never fails.
- Read paths still use live CTEs. Parity logging gates the cutover:
  set env `SUMMARY_PARITY_LOG=1` to log `dashboard_summary` vs live
  CTE on every `getKPIs` call. After 24h with zero diffs, perform
  Phase B (see [docs/AUDIT_FOLLOWUP.md](docs/AUDIT_FOLLOWUP.md)).
- After Phase B cutover the in-memory KPI cache becomes redundant and
  can be removed; reads collapse to a single row-per-org SELECT.

## Audit follow-up

Heavier items deferred from the 2026-05-17 audit have full implementation
plans in [docs/AUDIT_FOLLOWUP.md](docs/AUDIT_FOLLOWUP.md):
- **C1** — BigQuery `inventory`/`orders` partition+cluster migration
- **C2** — Refresh-token revocation table
- **Materialized summaries** — `dashboard_summary`/`inventory_summary`/`box_summary`
- **M3/M4** — Dashboard query consolidation + activity-log DML INSERT

---

# Core System Philosophy

Patman must operate as a centralized enterprise inventory and fulfillment platform with strict data consistency across all modules.

Primary priorities:

* inventory accuracy
* centralized calculations
* organization isolation
* secure session handling
* role-based permissions
* operational consistency
* maintainable architecture
* clean scalable codebase

The system should behave like a professional ERP/inventory platform, not a collection of disconnected pages.

---

# Centralized Inventory Calculation Engine

This is the MOST important architectural rule.

Never calculate inventory separately on different pages.

Instead:

1. Load inventory + orders data
2. Normalize data
3. Run all calculations through ONE centralized inventory engine/service
4. Store computed results in shared canonical state
5. Every page consumes the same processed dataset

Pages that MUST use the same source-of-truth:

* Dashboard
* Inventory List
* Orders
* Box Lookup
* Analytics
* Exports
* Reports

Future fixes should happen in ONE calculation layer only.

Never duplicate business logic across pages/components.

Accuracy is more important than instant rendering.

It is acceptable to:

* show loading overlays
* show syncing states
* process calculations before rendering

---

# Upload Architecture

Users:

* download CSV templates
* edit data in spreadsheet software
* upload back as `.txt` tab-delimited files

Reason:
`.txt` uploads support:

* better bulk ingestion
* simpler parsing
* stable large-file processing

System requirements:

* validate required fields
* normalize uploads before calculations
* reject malformed uploads safely
* support large batch processing

---

# Inventory Logic

## Physical Inventory Rules

Only actual fulfilled inventory-backed sales reduce stock.

The following MUST NOT reduce physical inventory:

* phantom units
* phantom orders
* undefined SKU orders
* unknown SKU orders

Remaining stock must NEVER go below zero because of phantom demand.

---

# Phantom Logic

Phantom units are informational analytics/warnings only.

Purpose:

* show oversold demand
* highlight attempted fulfillment beyond stock

Phantom units:

* appear in dashboard analytics
* appear in box lookup
* appear in inventory analytics

Phantom units MUST NOT:

* reduce physical stock
* create negative remaining inventory
* affect available inventory counts

Example:

Initial stock = 1
Units sold = 2
Phantom = 1

Correct:

* Actual Sold = 1
* Remaining = 0
* Phantom = 1

Incorrect:

* Remaining = -1

Never allow negative remaining caused by phantom sales.

---

# Dashboard KPI Logic

All KPIs must come from centralized calculations only.

Correct KPI formulas:

Total Units
= uploaded inventory quantity

Units Sold
= all order quantities

Actual Units Sold
= Units Sold - Phantom Units

Remaining Stock
= Total Units - Actual Units Sold

Phantom Units
= informational warning metric only

Undefined SKU Orders
= orders without valid inventory match

Undefined orders must not reduce stock.

---

# Box Lookup Logic

Users search by:

* part number
* SKU
* UPC

Results show:

* Initial
* Actual Sold
* Phantom
* Remaining

Grouped by:

* SKU
* box allocation

Remaining stock reflects REAL physical inventory only.

Phantom values are informational only.

Never reduce remaining below zero.

---

# Orders Page Logic

Orders page is a fulfillment management module.

It is NOT a phantom management page.

Do NOT:

* mark phantom orders at row level
* filter phantom rows
* assign phantom state to specific orders

Reason:
System cannot reliably determine WHICH oversold order became phantom.

Phantom logic exists ONLY at aggregated inventory analytics level.

---

# Shipped SKU Reassignment Logic

Users can reassign fulfillment SKU from Orders page.

Example:

Original ordered SKU:
ARA1-123-321

Alternative in-stock compatible SKUs:

* ARA2-123-321
* ARA3-123-321

Dropdown rules:

* show only compatible SKUs
* show only IN-STOCK SKUs
* show full SKU values
* exclude unavailable SKUs

Behavior:

Original order history remains unchanged.

Inventory deduction happens ONLY from reassigned shipped SKU.

Example:

Ordered:
ARA1-123-321

Reassigned shipped SKU:
ARA2-123-321

Correct behavior:

* deduct from ARA2-123-321
* do NOT deduct from ARA1-123-321

All related pages must instantly reflect this:

* dashboard
* inventory list
* box lookup
* exports
* analytics

Through centralized calculations only.

---

# Multi-User & Organization Management

The system supports:

* multiple organizations
* multiple users
* role-based permissions
* organization-level isolation

This architecture must be strict and secure.

---

# User Roles

## 1. Admin

Admins can:

* create organizations
* update organizations
* remove organizations
* create users
* update users
* remove users
* assign organizations
* assign user roles
* reset/change passwords
* manage uploads
* manage shipped SKU reassignment
* access all analytics
* access all reports
* manage system settings

Admins have full platform access.

---

## 2. Standard Users

Users can:

* access assigned organizations only
* upload inventory/orders
* manage shipped SKU reassignment
* use operational tools
* download reports
* access analytics

Users CANNOT:

* manage users
* manage organizations
* assign permissions
* change platform security settings

---

## 3. Viewers

Viewers are read-only users.

Viewers can:

* view dashboards
* view reports
* view analytics
* download reports

Viewers CANNOT:

* upload files
* edit shipped SKU
* modify inventory
* modify orders
* manage users
* manage organizations

---

# Organization Isolation & Security

Critical requirement:

Users must NEVER:

* access organizations not assigned to them
* inherit another user session
* view another organization's data
* cross-access protected records

Session handling must be strict.

Implement:

* proper auth isolation
* organization-scoped queries
* organization-level middleware validation
* role validation on every protected route
* secure session invalidation
* token validation
* organization permission checks

This is mandatory for every backend endpoint and frontend state load.

---

# Password & Access Management

If users need:

* password changes
* new organization access
* role changes

They must contact an admin.

Display clear notices inside profile/settings pages.

Only admins can:

* change passwords
* assign organizations
* update permissions

---

# UI & Dashboard Direction

System should resemble a professional ERP platform.

Priorities:

* compact layouts
* responsive sizing
* operational clarity
* clean analytics
* enterprise styling

Avoid:

* oversized cards
* spreadsheet-like dashboards
* duplicated KPI sections
* inconsistent spacing
* excessive scrolling

---

# Dashboard Layout Direction

Dashboard is the centralized control center.

Contains:

* KPI cards
* analytics
* reporting
* operational insights

Use:

* responsive KPI cards
* chart grids
* compact enterprise layout

Avoid:

* table-strip KPI rows
* fake cards
* oversized whitespace

Desktop should minimize scrolling.

---

# Performance & Responsiveness

Use:

* CSS grid
* minmax()
* flex layouts
* viewport-aware sizing
* internal scroll regions

Avoid:

* giant fixed heights
* excessive page scroll
* overflowing layouts

---

# Uploads Page

Upload controls should:

* remain sticky
* stay compact
* support fast operational workflows

Guide panel:

* displayed beside uploads
* compact
* scroll internally if needed

---

# Box Lookup Page

Dedicated operational page.

Requirements:

* sticky search
* empty state illustration
* proper no-results state
* responsive result layout

---

# Engineering & Maintenance Standards

Continuously audit:

* backend structure
* BigQuery schema
* API consistency
* legacy code
* unused CSS
* dead routes
* obsolete calculations

Clean old architecture aggressively after refactors.

Never allow:

* duplicate calculation paths
* outdated KPI logic
* legacy UI wrappers
* abandoned routes/components

---

# BigQuery & Backend Maintenance

Regularly validate:

* schema integrity
* organization isolation
* inventory consistency
* auth/session behavior
* permissions
* query performance

Ensure:

* migrations remain clean
* no stale columns
* no orphaned data structures
* no conflicting inventory logic

---

# Deployment & QA Rules

After every major change:

1. validate KPI consistency
2. validate inventory accuracy
3. validate organization isolation
4. validate role permissions
5. validate shipped SKU reassignment
6. validate uploads
7. validate exports
8. validate responsive layouts

Then:

* clean legacy code
* push changes to git
* redeploy backend/frontend if required
* verify production behavior

Accuracy, consistency, and maintainability are the highest priorities.
