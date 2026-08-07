# Audit Follow-Up Plan

This document captures the four heavier items deferred from the
enterprise-grade security/performance/architecture audit. Each section
contains the problem, the file:line evidence, and a step-by-step
implementation plan.

Issued: 2026-05-17
Source: full-stack audit (see chat transcript / FINDINGS report)

Session-7 Rolling 30-day data retention (2026-05-18, build
`2026-05-18-retention-30d`):

**Feature:** New `dataRetentionService` + `POST /admin/purge-old-data`
endpoint + Operational Diagnostics "Purge 30-Day Data" button.
Removes operational data older than 30 days (configurable per call)
while **preserving** user-identity data (`users`, `organizations`,
`memberships`). Purged: `inventory`, `orders`, `inventory_uploads`,
`order_uploads`, `activity_log`, and `refresh_tokens` (only rows
already expired past the cutoff). After the purge, the route
fire-and-forgets `summaryRefreshService.refresh()` for every active
org so `dashboard_summary` / `inventory_summary` / `box_summary_*`
converge to the post-purge state.

**How to trigger:**
- Admin UI: Settings → System Status → Operational Diagnostics →
  "Purge 30-Day Data" (type `PURGE 30` to confirm).
- API: `POST /admin/purge-old-data` with body `{ "days": 30 }`.
  Bounds: 1 ≤ days ≤ 3650.

**Recommended automation — Cloud Scheduler daily sweep:**

```bash
PROJECT_ID=patman-inventory
REGION=us-central1
SERVICE_URL=$(gcloud run services describe patman-inventory-api \
  --region=${REGION} --format='value(status.url)')

# 1. Create a dedicated SA that will authenticate the scheduler
#    request. Grant it roles/run.invoker on the Cloud Run service
#    so it can call the endpoint.
gcloud iam service-accounts create patman-retention-scheduler \
  --display-name="Patman retention scheduler"

SCHEDULER_SA=patman-retention-scheduler@${PROJECT_ID}.iam.gserviceaccount.com

gcloud run services add-iam-policy-binding patman-inventory-api \
  --region=${REGION} \
  --member=serviceAccount:${SCHEDULER_SA} \
  --role=roles/run.invoker

# 2. Give it admin role on the platform (the /admin route requires
#    requireRole('admin')). Simplest: mint an admin API user + create
#    a long-lived access token, use that as the Authorization header.
#    Alternatively wire OIDC-only auth on the /admin/purge-old-data
#    route as a follow-up.
#
#    For now, generate an admin session by logging in as any admin
#    user and grabbing the access_token from the response:
#
#      curl -s -X POST ${SERVICE_URL}/auth/login \
#        -H 'Content-Type: application/json' \
#        -d '{"username":"<admin>","password":"<pw>","remember":true}'
#
#    Copy the returned access_token — that's your ${ADMIN_TOKEN}.
#    (Bounded by JWT_ACCESS_EXPIRES — refresh periodically. A durable
#    scheduler token requires OIDC verification on /admin routes,
#    which is a separate hardening pass.)

# 3. Create the Cloud Scheduler job — daily at 03:00 UTC (low-load).
gcloud scheduler jobs create http patman-retention-daily \
  --location=${REGION} \
  --schedule='0 3 * * *' \
  --time-zone='UTC' \
  --uri="${SERVICE_URL}/admin/purge-old-data" \
  --http-method=POST \
  --headers="Content-Type=application/json,Authorization=Bearer ${ADMIN_TOKEN}" \
  --message-body='{"days":30}' \
  --attempt-deadline=540s
```

Once the job is created, `gcloud scheduler jobs run patman-retention-daily`
triggers it on demand for verification. The server logs a structured
`event: data_retention_purge_complete` line per invocation with the
per-target row counts.

---

Session-6 Phase B GCS staging + BigQuery LOAD JOB ingest (2026-05-18,
build `2026-05-18-phaseB-gcs-loadjob-ingest`):

**Problem:** Phase A made uploads return 202 quickly, but background
DML chunked writes still took ~5 minutes for 100k rows (200 INSERT
chunks @ ~1.5s each). 17k-row uploads took multiple minutes — well
under Cloud Run's timeout, but operationally unacceptable. BigQuery
itself is not the bottleneck: the DML chunk loop is.

**Phase B fix:**
- New [server/src/services/storageService.js](../server/src/services/storageService.js)
  wraps GCS. Streams NDJSON (gzipped, chunked writes) to
  `gs://${UPLOAD_BUCKET}/uploads/{upload_id}/{type}-adds.ndjson`.
- New `uploadsRepository.loadInventoryFromGcs(uri)` + `loadOrdersFromGcs(uri)`
  submit a BigQuery LOAD JOB with the canonical schema, `WRITE_APPEND`,
  `CREATE_NEVER`, and await completion (errors re-thrown for fallback).
- `pipelineRunner` Phase 4 Add path routes through the LOAD JOB when
  `storageService.enabled === true` and falls back to chunked DML
  otherwise. Update + Remove stay on DML — LOAD JOB can't do partial
  updates.
- **Per-phase timing**: every pipeline run emits an
  `upload_pipeline_complete` structured log with
  `parse_ms / key_fetch_ms / validate_ms / gcs_stage_ms /
   load_job_ms / adds_ms / updates_ms / removes_ms / total_ms /
   add_path` so the operator has exact bottleneck visibility.
- **Fail-soft**: when `UPLOAD_BUCKET` env is unset, the service stays
  disabled and the pipeline uses the existing DML path — same
  correctness, slower. Operator wires GCS at their pace.
- Refresh-path audit (per the user's explicit ask): every mutating
  route calls `summaryRefreshService.refresh()` exactly once; the
  existing 500ms leading+trailing debounce inside the service
  collapses any burst into ≤2 actual rebuilds. No duplicate firing.

**Performance targets** (LOAD JOB path):
- 17k rows: ~3s ingest + ~30s refresh ≈ **under a minute end-to-end**.
- 100k rows: ~10-15s ingest + ~30-60s refresh ≈ **operationally practical**.

**Operator GCP setup (required to activate Phase B speedup):**

```bash
PROJECT_ID=patman-inventory
REGION=us-central1
BUCKET=patman-inventory-uploads
RUNTIME_SA=<existing-cloud-run-sa>@${PROJECT_ID}.iam.gserviceaccount.com

# 1. Create the GCS bucket in the same region as Cloud Run +
#    BigQuery so cross-region egress doesn't slow ingestion.
gcloud storage buckets create gs://${BUCKET} \
  --location=${REGION} \
  --uniform-bucket-level-access

# 2. Lifecycle policy: auto-delete staged NDJSON after 1 day as a
#    safety net in case the pipeline's best-effort deleteObject misses.
cat > /tmp/lifecycle.json <<'EOF'
{
  "rule": [
    { "action": { "type": "Delete" },
      "condition": { "age": 1, "matchesPrefix": ["uploads/"] } }
  ]
}
EOF
gcloud storage buckets update gs://${BUCKET} \
  --lifecycle-file=/tmp/lifecycle.json

# 3. Grant the Cloud Run runtime SA object admin on the bucket.
gcloud storage buckets add-iam-policy-binding gs://${BUCKET} \
  --member=serviceAccount:${RUNTIME_SA} \
  --role=roles/storage.objectAdmin

# 4. Grant the runtime SA permission to submit BigQuery LOAD JOBs
#    (jobs.create at the project level). Most orgs already have
#    roles/bigquery.jobUser on the runtime SA — verify:
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member=serviceAccount:${RUNTIME_SA} \
  --role=roles/bigquery.jobUser

# 5. Set the env var on Cloud Run + redeploy. Confirm at boot via
#    the log line: "[BOOT] GCS staging  enabled=true  bucket=..."
gcloud run services update patman-inventory-api --region=${REGION} \
  --update-env-vars=UPLOAD_BUCKET=${BUCKET}
```

Once the env var is live, the LOAD JOB path engages automatically.
Verify by uploading a small inventory file and inspecting the
`upload_pipeline_complete` log entry: `add_path=load_job` =
Phase B is active; `add_path=dml_no_gcs` = still on the fallback.

---

Session-5 Phase A async upload lifecycle that landed (2026-05-18, build
`2026-05-18-phaseA-async-upload-lifecycle`):

**Problem:** 100k-row uploads were timing out at Cloud Run's 60s
request budget. Root cause: `pipelineRunner` Phase 4 runs 200
sequential DML INSERT chunks @ ~1.5s each ≈ 5 minutes,
SYNCHRONOUSLY inside the HTTP request. Plus `summaryRefreshService`
fired off after writes complete. Cloud Run killed the connection
mid-flight → browser surfaced it as a CORS / 504 / "no
Access-Control-Allow-Origin" error.

**Phase A fix shipped:**
- `POST /uploads/inventory` + `POST /uploads/orders` now return
  **202 + `{ upload_id, status: 'accepted' }`** within ~2-5s for any
  upload size. The route buffers the file, INSERTs an `accepted`
  audit row, schedules background processing via `setImmediate`,
  and returns immediately.
- Background task (same Cloud Run instance, after response is sent):
    1. `setUploadProcessing` → status `processing`
    2. Runs `pipelineRunner` Phase 2-4 (the existing DML chunked
       writes — unchanged write strategy, deferred to Phase B)
    3. `finalizeUploadJob` → terminal status `success` / `partial` /
       `failed` + report text + `last_error`
    4. `dashboardService.invalidateKPICache(orgId)`
    5. `cloudTasksService.enqueueRefresh(...)` → out-of-band refresh
- New endpoint `GET /uploads/status/:upload_id` → returns canonical
  job row + derived `phase` (`accepted` | `processing` | `refreshing`
  | `complete` | `failed`) for the UI to switch on.
- Frontend ([js/uploads.js](../js/uploads.js)) polls status every 2s
  with a 15-min ceiling, shows a 4-step progress strip (`Queued →
  Writing rows → Refreshing analytics → Complete`).
- Cloud Run runtime: `--timeout=540` + `--min-instances=1` keep the
  warm instance alive long enough to finish 100k-row background DML
  on the same instance after the 202 response is sent.
- `/tasks/refresh-summaries` worker route with OIDC verification via
  Google's `tokeninfo` endpoint (no `google-auth-library` dep needed
  — keeps the bundle thin). Validates issuer, `email` claim against
  `TASKS_INVOKER_SA`, and `aud` claim against the expected worker URL.
- `cloudTasksService` is **fail-soft** — when `TASKS_LOCATION` /
  `TASKS_QUEUE_NAME` / `WORKER_BASE_URL` / `TASKS_INVOKER_SA` aren't
  all set, it runs the refresh inline on the same Node task (same
  correctness, just no out-of-band scheduling). This means the code
  is shippable BEFORE the operator creates the queue + IAM — the
  upload lifecycle works end-to-end immediately.

**Operator GCP setup (required to activate Cloud Tasks scheduling):**

```bash
PROJECT_ID=patman-inventory
REGION=us-central1
RUNTIME_SA=<existing-cloud-run-sa>@${PROJECT_ID}.iam.gserviceaccount.com
INVOKER_SA=patman-tasks-invoker@${PROJECT_ID}.iam.gserviceaccount.com

# 1. Create the Cloud Tasks queue.
gcloud tasks queues create patman-summary-refresh --location=${REGION}

# 2. Create a dedicated invoker SA (signs OIDC tokens for the task).
gcloud iam service-accounts create patman-tasks-invoker \
  --display-name="Patman Cloud Tasks invoker"

# 3. Let the invoker SA call this Cloud Run service.
gcloud run services add-iam-policy-binding patman-inventory-api \
  --region=${REGION} \
  --member=serviceAccount:${INVOKER_SA} \
  --role=roles/run.invoker

# 4. Let the runtime SA enqueue tasks + impersonate the invoker SA
#    (needed for Cloud Tasks to mint OIDC tokens as the invoker).
gcloud tasks queues add-iam-policy-binding patman-summary-refresh \
  --location=${REGION} \
  --member=serviceAccount:${RUNTIME_SA} \
  --role=roles/cloudtasks.enqueuer
gcloud iam service-accounts add-iam-policy-binding ${INVOKER_SA} \
  --member=serviceAccount:${RUNTIME_SA} \
  --role=roles/iam.serviceAccountTokenCreator

# 5. Set env vars on Cloud Run + redeploy. The boot log line
#    "[BOOT] Cloud Tasks  enabled=true ..." confirms it picked up.
gcloud run services update patman-inventory-api --region=${REGION} \
  --update-env-vars=\
TASKS_LOCATION=${REGION},\
TASKS_QUEUE_NAME=patman-summary-refresh,\
WORKER_BASE_URL=https://patman-inventory-api-471065748321.us-central1.run.app,\
TASKS_INVOKER_SA=${INVOKER_SA}
```

**Required migration** (run BEFORE deploying the new build):
`server/sql/migrations/20260518_001_async_upload_lifecycle.sql` — adds
`refreshed_at` + `last_error` columns to both upload tables.

**Known Phase A limitations (addressed by Phase B next session):**
- The DML chunked write strategy is unchanged. 100k-row uploads
  STILL take ~5 minutes to fully process in the background — the
  user just sees the upload accept in 2-5s and watches a polling
  badge. Phase B replaces the DML loop with a single BigQuery
  LOAD JOB (via GCS staging) which drops the write time to ~10-15s.
- Background work is tied to the Cloud Run instance lifetime.
  `--min-instances=1` keeps one warm; a true distributed worker
  would be Cloud Tasks invoking a separate Cloud Run service with
  the full payload (Phase C). For Phase A scale (single org doing
  one upload at a time) `--min-instances=1` is sufficient.

---

Session-4 Phase B validation tooling that landed (2026-05-17, build
`2026-05-17-phaseB-validation`):
- **`GET /admin/parity-report?hours=24`** — queries Cloud Logging for all
  `parity_*` events in the window, aggregates per (org, surface,
  outcome), returns a structured report with an explicit
  `ready_for_cutover.{dashboard,sku,box}` boolean per surface. This is
  the cutover go/no-go gate.
- **`GET /admin/refresh-health?hours=24`** — aggregates
  `summary_refresh_table` + `summary_refresh_complete` events: per-org
  refresh count, p50/p95 durations, failure count, last failure detail.
- **`POST /admin/refresh-all-orgs`** — eliminates the "this org never
  had a mutation since the migration" class of parity_*_missing events
  by force-firing a refresh for every active org. Uses the same
  coalescing protection as ordinary refresh triggers.
- **`@google-cloud/logging` dependency added** to `server/package.json`.
  Operator must grant `roles/logging.viewer` to the Cloud Run service
  account or the two report endpoints return 503 with a clear message.
- **Sample-size fields on `parity_match` logs** so 24h aggregates have
  total volume in addition to the boolean match/diff signal. Lets
  operators verify they're judging cutover readiness off sufficient
  observation, not 3 dashboard hits.
- See "Phase B parity-validation workflow" in CLAUDE.md for the step-by-step
  go-live procedure.

Session-3 Phase B prep work that landed (2026-05-17, build `2026-05-17-phaseB-prep`):
- **CR1 (HIGH)** — `summaryRefreshService` rebuilds rewritten as single
  `MERGE` statements per table with `WHEN NOT MATCHED BY SOURCE AND
  T.organization_id = @x`. Eliminates the duplicate-row hazard under
  concurrent refresh and removes the empty-rows visibility window.
  Idempotent under concurrent execution.
- **CR2 (HIGH)** — Box Lookup reverted from materialized read to live
  CTE. Parity-log path runs the new split-table read in parallel and
  emits `parity_box_match` / `parity_box_diff` / `parity_box_summary_empty`
  events when `SUMMARY_PARITY_LOG=1`. Phase B Box Lookup cutover now
  follows the same gated path as dashboard.
- **CR3 (HIGH)** — Process-local refresh coalescing in
  `summaryRefreshService.refresh`. Leading-edge + trailing debounce
  with a 500ms cooldown per org. A burst of N mutations on the same org
  produces at most 2 refreshes instead of N.
- **HI2 (MEDIUM)** — Per-table structured logging
  (`event: summary_refresh_table` + duration_ms + status). New admin-only
  endpoint `GET /admin/summary-status?org=X` returns per-table row count +
  `last_refreshed_at`. Also `POST /admin/summary-refresh` to force-rebuild
  a single org (useful for orgs that haven't had a mutating operation
  since the migration).
- **HI3 (HIGH)** — SKU View parity logging extended to match the
  dashboard pattern. `inventoryMetricsService.getSkuSummary` now runs a
  parallel read from `inventory_summary` with the same filters and
  emits `parity_sku_match` / `parity_sku_diff` / `parity_sku_total_diff`
  / `parity_sku_summary_empty` when `SUMMARY_PARITY_LOG=1`.
- **App Version surfaced in Settings → System Status**. `/health`
  endpoint returns `version: '2026-05-17-phaseB-prep'`. Build version
  log lives in CLAUDE.md.

Session-2 architecture work that landed (2026-05-17, later in the day):
- **Drift prevention** — extracted shared CTE builders to
  [server/src/utils/skuPivots.js](../server/src/utils/skuPivots.js).
  `ordersAggCTE` / `invAggCTE` / `perSkuCTE` are now defined ONCE and
  imported by `inventoryMetricsService`, `summaryRefreshService`,
  `lookupRepository`, `inventoryRepository.findAlternativeBoxes`. The
  duplicated CTE bodies in those services are gone — live and
  materialized paths cannot drift because they share source text.
- **D1 fix (Option A)** — `isUndefinedSql` now wraps the SKU column in
  `UPPER(IFNULL(...))` before regex match
  ([server/src/utils/inventoryPatterns.js](../server/src/utils/inventoryPatterns.js)).
  Default character classes are already uppercase-only
  (`[A-Z0-9]+`). Frontend `normalizeSku` already uppercases when
  `case_insensitive: true` (default). All three classifier paths
  (modal validator, SQL `isUndefinedSql`, summary refresh) now produce
  identical results.
- **Box Lookup Option D** — `box_summary` split into
  `box_summary_by_upc` (clustered org + upc_norm) and
  `box_summary_by_part` (clustered org + part_norm). Each table has a
  normalized clustered column populated at refresh time via
  `LOWER(TRIM(...))`. `summaryRefreshService` writes BOTH on every
  refresh. `lookupRepository.search` routes by query shape
  (numeric 8-14 digits → by_upc; else → by_part) with cross-table
  fallback on empty result. See "Box Lookup architecture decision"
  section below for the full analysis.
- **My Profile tab removed** from Settings (markup + handler + tab-init
  function deleted; no other surface depended on it).

Session-1 fixes that already landed (do NOT re-do):
- M1: `/auth/switch-org` `is_active` check
- M2: frontend `switchOrg` writes new refresh token
- M5: deleted dead BQ-v2 fallback proxy
- L2: deleted dead `notIgnored` SQL fragment
- M9: deleted dead `ALLOWED_MIME` constant
- M10: deleted orphan `.tmp` file + added `*.tmp.*` to `.gitignore`
- M6: deleted orphan API methods + `GET /inventory/` + `GET /inventory/export`
       + `inventoryService.list/exportAll` + `inventoryRepository.findAll/exportAll`
- M7: deleted `backend/*.gs` legacy Apps Script
- M8: archived legacy migration JSONs under `server/migrations/_archive/`
- H1: introduced backend KPI cache (per-org, 60s TTL, real `invalidateKPICache`)

---

## C1 — BigQuery partition/cluster migration (highest cost-impact)

### Problem
The two largest BigQuery tables have no partitioning or clustering:
- [server/sql/schema/04_inventory.sql](../server/sql/schema/04_inventory.sql)
- [server/sql/schema/05_orders.sql](../server/sql/schema/05_orders.sql)

Every query (`WHERE organization_id = @x` and `WHERE order_date >= @date`)
scans the entire physical table. Cost grows multiplicatively with orgs ×
active users × page loads.

The older migration `002_inventory_schema.sql` had `CLUSTER BY
organization_id, sku` and `CLUSTER BY organization_id, order_date` — that
was lost when the canonical DDL was rewritten.

### Target schema
```sql
-- inventory
CREATE TABLE patman-inventory.patman_inventory.inventory_new (
  ... same columns ...
)
CLUSTER BY organization_id, sku;

-- orders
CREATE TABLE patman-inventory.patman_inventory.orders_new (
  ... same columns ...
)
PARTITION BY DATE(SAFE_CAST(order_date AS DATE))
CLUSTER BY organization_id, sku;
```

Why partition `orders` by `order_date` and not `created_at`:
- All filtering in `dashboardRepository.getPerformance` already uses
  `SAFE_CAST(order_date AS DATE)` predicates. Partition pruning will kick
  in automatically.
- `created_at` is upload-time which has near-flat distribution and doesn't
  help pruning.

Why cluster `inventory` only (no partition):
- No timestamp-shaped predicate in the inventory hot path.
- Clustering by `(organization_id, sku)` is exactly aligned with every
  `WHERE organization_id = @x [AND sku = @y]` access pattern.

### Migration plan (zero-downtime)
1. **Create new tables** with partition + cluster:
   ```sql
   CREATE TABLE patman-inventory.patman_inventory.inventory_new
   PARTITION BY ...
   CLUSTER BY organization_id, sku
   AS SELECT * FROM patman-inventory.patman_inventory.inventory;
   ```
2. **Verify row counts match**:
   ```sql
   SELECT COUNT(*) FROM inventory;
   SELECT COUNT(*) FROM inventory_new;
   ```
3. **Atomic rename**:
   ```sql
   ALTER TABLE inventory RENAME TO inventory_old;
   ALTER TABLE inventory_new RENAME TO inventory;
   ```
4. **Smoke-test the app** against the renamed table (read paths).
5. **Drop the old table** after a 24-hour grace period.
6. Repeat for `orders`.

### Pitfalls to avoid
- BigQuery's `CREATE TABLE ... AS SELECT` doesn't carry partitioning;
  must be declared explicitly in the new DDL.
- Streaming inserts to a recently-created table can have a buffer delay;
  pause uploads during the swap window (~5 minutes).
- Run during low-traffic window; the verification COUNT pair can be
  ~30 seconds for very large tables.

### Expected impact
- 5-10× scan reduction on dashboard queries (only the org's slice).
- Partition pruning on date-range queries: `Last 12 weeks` reads
  ~12 partitions instead of full history.
- No application code change required.

---

## C2 — Refresh-token revocation table (highest security-impact)

### Problem
[server/src/repositories/refreshTokensRepository.js](../server/src/repositories/refreshTokensRepository.js)
is a fully-stubbed module. `isRevoked()` returns `false`. No `save()` is
ever called. A leaked refresh token works for the full
`JWT_REFRESH_EXPIRES` (7 days) regardless of password change, logout, or
user deactivation.

### Target table
```sql
CREATE TABLE patman-inventory.patman_inventory.refresh_tokens (
  jti              STRING    NOT NULL,
  user_id          STRING    NOT NULL,
  organization_id  STRING,
  created_at       TIMESTAMP NOT NULL,
  expires_at       TIMESTAMP NOT NULL,
  revoked          BOOL      NOT NULL DEFAULT FALSE,
  revoked_at       TIMESTAMP,
  revoked_reason   STRING               -- 'logout' | 'password_change' | 'user_deactivated' | 'admin'
)
PARTITION BY DATE(expires_at)
CLUSTER BY user_id, jti;
```

### Implementation steps
1. **Migration file** `server/sql/migrations/20260517_001_create_refresh_tokens.sql`
   with the DDL above.
2. **Implement the repo methods** in `refreshTokensRepository.js`:
   - `save(jti, userId, organizationId, expiresAt)` — DML INSERT
   - `isRevoked(jti)` — SELECT revoked WHERE jti; unknown jti = treat as revoked
   - `revoke(jti, reason)` — UPDATE SET revoked = TRUE
   - `revokeAllForUser(userId, reason)` — UPDATE all user's tokens
3. **Wire into the auth flow** (`server/src/routes/auth.js`):
   - After every `tokenFactory.signRefreshToken()`, call `save()`.
   - At the top of `/auth/refresh`, after JWT verify, decode the `jti`
     and call `isRevoked()` — reject with 401 if revoked.
4. **Add `/auth/logout`** endpoint that calls `revoke(jti, 'logout')`.
   Frontend should call this before clearing local session.
5. **Wire `revokeAllForUser`** into:
   - `usersService.updateGlobalUser` when `is_active` becomes false
   - `usersService.updateGlobalUser` when password changes
6. **Inject `refreshTokensRepo`** into the auth route module in `server.js`.

### Frontend changes
- [js/auth.js](../js/auth.js) `logout()` — POST `/auth/logout` with the
  refresh token in the body before clearing local storage.

### Pitfalls to avoid
- Don't `revoke()` synchronously on every refresh — keep refresh-token
  rotation: revoke the old `jti` and save the new one in the SAME flow.
  Otherwise an interrupted refresh leaves the user with no usable token.
- `revoke` failures must not fail the login/logout endpoint — wrap in
  try/catch and log; security degrades to "as before" but the user
  isn't locked out.

### Expected impact
- Logout actually invalidates the refresh token immediately.
- Password change immediately invalidates all sessions for that user.
- User deactivation immediately invalidates all sessions.
- Auditable revocation trail.

---

## Materialized summary tables — Phase A SHIPPED · Phase B PENDING

### Phase A — Foundation, dual-write, parity logging (LANDED 2026-05-17)

What shipped:

- [server/sql/migrations/20260517_002_materialized_summaries.sql](../server/sql/migrations/20260517_002_materialized_summaries.sql) —
  DDL for three clustered summary tables: `dashboard_summary`,
  `inventory_summary`, `box_summary`. **Operator must run this migration
  before the new server build goes live**, otherwise summary writes 404
  the table and refresh logs warnings. (Reads still work via live CTEs.)
- [server/src/services/summaryRefreshService.js](../server/src/services/summaryRefreshService.js) —
  `refresh(orgId)` rebuilds all three summaries for one org via
  DELETE-then-INSERT inside a single org scope. Uses the same shared
  CTE template (`_ordersAggCTE` / `_invAggCTE` / `_perSkuCTE`) as
  `inventoryMetricsService` so the math is identical byte-for-byte.
- Wired into every mutating route:
  - [routes/uploads.js](../server/src/routes/uploads.js) — inventory + orders uploads
  - [routes/inventory.js](../server/src/routes/inventory.js) — PATCH + DELETE
  - [routes/orders.js](../server/src/routes/orders.js) — PATCH + DELETE + reassign
  - [routes/organizations.js](../server/src/routes/organizations.js) — when `sku_structure` changes
  - All fire-and-forget (`.catch(() => {})`); refresh failures don't fail the mutation.
- [server/src/services/dashboardService.js](../server/src/services/dashboardService.js) —
  Phase A parity logging: when `SUMMARY_PARITY_LOG=1` env is set, every
  `getKPIs` ALSO reads from `dashboard_summary` and emits a structured
  log line:
  - `event: parity_match` — values agree
  - `event: parity_diff` — values disagree; includes per-field {live, summary, delta}
  - `event: parity_summary_missing` — no summary row for this org yet
  - Read path still returns the LIVE CTE result. No behavior change.

### Phase B — Read-path cutover (PENDING)

**Do not start until parity logs show zero diffs across all active orgs for
at least 24 hours.**

Validation steps before cutover:
1. Run the migration in BigQuery. Verify the three tables exist with
   the documented clustering.
2. Trigger an inventory + orders upload on a test org so a refresh runs.
   Verify rows appear in the three summary tables.
3. Enable `SUMMARY_PARITY_LOG=1` on the Cloud Run revision serving prod
   (or staging). Let users use the dashboard normally for 24 hours.
4. Filter logs for `event: parity_diff` or `event: parity_summary_missing`.
   - If any diffs: investigate, fix the refresh service, redeploy, repeat.
   - If only `parity_summary_missing`: those orgs have never had a mutating
     operation since the migration — trigger a refresh for them
     (e.g. open the org's settings + save sku_structure unchanged → fires
     the refresh path).
5. Once 24 hours pass with zero diffs, proceed.

Cutover changes:
1. `dashboardService.getKPIs(orgId)` →
   - First attempt: `SELECT * FROM dashboard_summary WHERE organization_id = @orgId LIMIT 1`.
   - If row exists and `refreshed_at` is recent enough (e.g. < 24h),
     return it directly. Skip the live CTE path entirely.
   - If row missing: fall back to live CTE (`metricsService.computeSummary`)
     AND trigger an async `summaryRefreshService.refresh(orgId)` to fix
     the missing row for next time.
2. `inventoryMetricsService.getSkuSummary(orgId, opts)` →
   - Replace the per-call CTE chain with `SELECT ... FROM
     inventory_summary WHERE organization_id = @orgId AND <filter>
     ORDER BY ... LIMIT N OFFSET M`. Same column shape as today.
3. `lookupRepository.search(orgId, q)` →
   - Replace the local CTE pipeline with
     `SELECT ... FROM box_summary WHERE organization_id = @orgId
     AND (upc = @q OR part_number = @q) ORDER BY part_number, upc,
     remaining_stock DESC`.
4. Remove `SUMMARY_PARITY_LOG` checks from dashboardService.
5. Remove the 60s in-memory KPI cache (H1) — single-row SELECT is
   already cheap enough. Keep the `invalidateKPICache` no-op shim so
   existing call sites still compile.
6. Delete the unused CTE methods that no longer have callers:
   - `inventoryMetricsService.computeSummary` (kept as a private helper
     for refresh service if needed)
   - `inventoryMetricsService.getSkuSummary` live CTE path
   - The duplicate `ord_summary` CTEs in `inventoryRepository.findAlternativeBoxes`
     (refactor to read from `box_summary` joined on box_number).

Expected impact after cutover:
- Dashboard load: 2 BQ queries (~1.5s) → 1 single-row SELECT (~50ms).
- SKU View load: 1 large BQ query with CTE chain (~1s) → 1 indexed
  range scan (~100ms).
- Box Lookup: ~10× improvement.
- Multi-org cost scales linearly with org count, not org × user × page.

### Original Materialized summary tables plan

### Problem
H1 (KPI cache) shipped a 60s in-memory cache, which fixes the common
read pattern (dashboard load → tab focus → idle). It does NOT eliminate
the underlying BigQuery scans — every cache miss still runs the full
`_ordersAggCTE` + `_invAggCTE` + `_perSkuCTE` pipeline against the raw
tables.

Architecture mandate (your direction): "ensure summaries rebuild ONLY
after uploads / deletes / shipped SKU reassignment / inventory mutations
/ validation structure changes."

### Target tables
```sql
-- dashboard-level summary: one row per org, refreshed on upload/edit/delete
CREATE TABLE patman-inventory.patman_inventory.dashboard_summary (
  organization_id          STRING    NOT NULL,
  total_skus               INT64,
  total_units              INT64,
  fulfilled_units          INT64,
  phantom_units            INT64,
  physical_remaining_units INT64,
  in_stock_skus            INT64,
  oos_skus                 INT64,
  phantom_skus             INT64,
  undefined_skus           INT64,
  units_sold_raw           INT64,
  unknown_units_sold       INT64,
  unknown_orders           INT64,
  wrong_part_units         INT64,
  total_orders             INT64,
  active_platforms         INT64,
  refreshed_at             TIMESTAMP NOT NULL
)
CLUSTER BY organization_id;

-- per-SKU summary: powers SKU View directly
CREATE TABLE patman-inventory.patman_inventory.inventory_summary (
  organization_id   STRING    NOT NULL,
  sku               STRING    NOT NULL,
  total_stock       INT64,
  sold_units        INT64,
  fulfilled_units   INT64,
  phantom_units     INT64,
  remaining_units   INT64,
  boxes_count       INT64,
  last_added_at     STRING,
  part_number       STRING,
  upc               STRING,
  is_undefined      BOOL,
  refreshed_at      TIMESTAMP NOT NULL
)
CLUSTER BY organization_id, sku;

-- box-level summary: powers Box Lookup
CREATE TABLE patman-inventory.patman_inventory.box_summary (
  organization_id   STRING    NOT NULL,
  upc               STRING    NOT NULL,
  part_number       STRING    NOT NULL,
  box_number        STRING    NOT NULL,
  initial_stock     INT64,
  fulfilled_units   INT64,
  phantom_units     INT64,
  remaining_stock   INT64,
  refreshed_at      TIMESTAMP NOT NULL
)
CLUSTER BY organization_id, upc;
```

### Refresh strategy
Create `summaryRefreshService.refresh(orgId)` that runs three DML
INSERT...SELECT statements (using the existing CTE templates from
`inventoryMetricsService`) into the summary tables, scoped to a single
org. Total runtime per org: 2-5 seconds.

Trigger points:
- `uploadsService.processInventoryUpload` — after the upload commits
- `uploadsService.processOrdersUpload` — after the upload commits
- `inventoryService.updateRow` — after any inventory edit
- `inventoryService.deleteRows` — after any inventory delete
- `ordersService.updateRow` — after any shipped-SKU reassignment
- `ordersService.deleteRows` — after any order delete
- `organizationsRepo.update` — when `sku_structure` changes (affects
  `is_undefined` classification)

### Read-path changes
- `dashboardService.getKPIs(orgId)` → single `SELECT * FROM dashboard_summary
  WHERE organization_id = @orgId LIMIT 1`. No CTEs.
- `inventoryMetricsService.getSkuSummary(orgId, opts)` → `SELECT ... FROM
  inventory_summary WHERE organization_id = @orgId AND <filters>
  ORDER BY ... LIMIT N OFFSET M`. No CTEs.
- `lookupRepository.search(orgId, q)` → `SELECT ... FROM box_summary
  WHERE organization_id = @orgId AND (upc = @q OR part_number = @q)`.
- The in-memory KPI cache (H1) can be REMOVED after this lands — the
  read is already cheap.

### Pitfalls to avoid
- Refresh failures must not fail the originating upload/edit. Wrap in
  try/catch + log; stale-by-1-upload is acceptable, broken upload is not.
- The `refreshed_at` column lets the UI show a "Updated X seconds ago"
  marker if needed.
- During the transition, run BOTH the live CTE and the summary read in
  parallel for a week and diff the results in logs. Cut over when zero
  diffs.

### Expected impact
- Dashboard load: 2 BQ queries (~1.5s) → 1 BQ query (~50ms) → with cache:
  ~5ms.
- SKU View load: 1 large BQ query (~1s) → 1 small index seek (~100ms).
- Box Lookup: similar 10× improvement.
- Multi-org cost scales linearly with org count, not with org × user
  × page-view.

---

## M3 — Merge dashboard's two BQ queries into one + M4 — Activity log to DML INSERT + partitioning

### M3: dashboard query consolidation
[server/src/services/inventoryMetricsService.js:162-165](../server/src/services/inventoryMetricsService.js#L162-L165)

`summaryQuery` (per-SKU pivot) and `ordersQuery` (raw totals + unknown counts
via LEFT JOIN to inv_skus) currently run as `Promise.all`. They share the
`inv_skus` CTE conceptually.

Fix: rewrite as one query returning two row groups (UNION ALL with a `kind`
column, or use a single `WITH ...` that returns a struct).

Halves BQ requests on the hot path. This becomes moot once materialized
summaries land — leave M3 until after that decision is made.

---

## D1 — Undefined-SKU classification disagrees with the SKU structure validator (drift bug)

### Problem
The org's SKU structure modal validates a sample SKU live and shows it as
✓ Valid, but the dashboard / SKU View classifies the same SKU as
**Undefined**. Reproduced 2026-05-17 with:

- Org structure: `ARA - [{Box}] - {Part Number} - {UPC}`
- Tested SKU: `ARA100-NoMdel-887220767414` → modal says ✓ Valid
- Inventory page: same SKU rendered with the amber **UNDEFINED** badge

This violates the centralized-engine mandate: two code paths claim to
apply the same SKU structure rule but produce opposite results.

### Suspected root cause
- **Modal validator** (frontend JS) compares against the structure with
  `normalizeSku` applied first — which uppercases the SKU when
  `case_insensitive: true`. So `NoMdel` becomes `NOMDEL` before regex
  match. See [server/src/utils/skuEngine.js:289-295](../server/src/utils/skuEngine.js#L289-L295).
- **SQL classifier** uses `REGEXP_CONTAINS(IFNULL(sku, ''), @sku_regex)`
  in `isUndefinedSql` ([server/src/utils/inventoryPatterns.js:57-74](../server/src/utils/inventoryPatterns.js#L57-L74)).
  BigQuery RE2 is **case-sensitive by default**. The compiled regex
  doesn't include `(?i)` or an uppercased character class — so a SKU
  with mixed-case part-number text (`NoMdel`) fails the regex even
  though the structure is `case_insensitive: true`.

The validator and the classifier diverge whenever the SKU contains
lowercase characters AND the structure is configured `case_insensitive`.

### Confirmation steps (when picking this up)
1. Read `compileSegmentsRegex` in [server/src/utils/skuEngine.js:259-282](../server/src/utils/skuEngine.js#L259-L282) — confirm whether the
   compiled regex has any case-folding marker.
2. Read `_segmentBody` to see the character class used for `letters_and_numbers` / `letters` segments. If it's `[A-Z]+` it requires
   uppercase; if `[A-Za-z]+` or `[A-Z0-9]+` etc.
3. Run in BQ console:
   ```sql
   SELECT REGEXP_CONTAINS('ARA100-NoMdel-887220767414', r'^ARA…')
   ```
   with the literal compiled regex from `organizations.sku_structure` to
   confirm the false-negative.

### Fix options

**A. Apply the same normalization in SQL** (recommended)
Update `isUndefinedSql` to `UPPER(IFNULL(sku, ''))` before the regex
check whenever the structure is `case_insensitive: true`. The compiled
regex then only needs to match the uppercase form.

```sql
-- in isUndefinedSql (when case_insensitive)
NOT REGEXP_CONTAINS(UPPER(IFNULL(sku, '')), @sku_regex)
```

The corresponding regex compilation should produce uppercase character
classes (`[A-Z0-9]+` not `[A-Za-z0-9]+`) when case_insensitive is set.

**B. Switch BQ regex to RE2's inline case flag**
Prepend `(?i)` to the compiled regex when `case_insensitive: true`.
BigQuery RE2 supports `(?i)` for case-insensitive matching. This is the
lowest-touch fix — change one line in `compileSegmentsRegex`.

```javascript
// in compileSegmentsRegex
const prefix = s.case_insensitive ? '(?i)' : '';
return `${prefix}^${body}$`;
```

Option B is the smaller change but less explicit; option A keeps the
regex pure and moves all case logic to one place.

### Impact when fixed
- Inventory rows like `ARA100-NoMdel-887220767414` (mixed-case
  "letters & numbers" segments) will correctly classify as **valid**.
- Dashboard Undefined SKU KPI count drops by however many rows have
  this shape.
- SKU View no longer shows misleading amber-tinted rows for
  legitimately-structured SKUs.

### Test plan
1. Pick 3 SKUs that differ only in casing of letter segments
   (`ARA1-AB12-12345`, `ARA1-Ab12-12345`, `ARA1-aB12-12345`).
2. In an org configured `case_insensitive: true`, all three must:
   - Validate as ✓ in the modal validator.
   - NOT appear in the Undefined SKU filter on SKU View.
   - NOT add to the dashboard "Undefined SKUs" KPI.
3. In an org configured `case_insensitive: false`, only the
   canonically-cased SKU should pass.

---

---

## D2 — Hard-delete option for users and organizations

### Goal
Today the Settings page can only **deactivate** users and orgs (sets
`is_active = false`; row is preserved for audit). Operators need a way to
**permanently delete** rows when:
- A test user / sandbox org needs to be removed completely.
- Compliance / GDPR-style erasure requests.
- A misconfigured org needs a clean rebuild without trailing data.

Deactivate must remain the default action — hard delete is opt-in,
secondary, and clearly destructive.

### UX requirements
- Settings → Users list:
  - Existing **Deactivate** button stays as primary trailing action.
  - Add a **Delete permanently** button in the row's overflow menu
    (kebab `⋮`), styled with destructive red text and an icon.
- Settings → Organizations list:
  - Same pattern. Deactivate stays primary; Delete in overflow.
- Confirmation modal:
  - Title: "Delete user / organization permanently"
  - Body lists what will be removed (memberships, audit refs, etc.).
  - Operator must **type the username / org slug** to enable the
    Delete button. Same as how DROP TABLE prompts in DBeaver/etc.
  - Final button is `Delete forever` (btn-danger).

### Backend contract

**User hard delete**: `DELETE /users/:id/permanent` (admin only)

What it removes:
- `users` row
- `memberships` rows for this user (across all orgs)
- `refresh_tokens` rows for this user (once C2 lands)

What it preserves (for audit):
- `activity_log` rows — `user_id` is nullable, so we NULL it out instead
  of cascade-deleting history. The audit log still shows "User X
  uploaded inventory" but with the user reference replaced by a
  placeholder ("deleted user").
- `inventory.uploaded_by`, `orders.uploaded_by` — same treatment, NULL out.

Pre-flight safety check:
- Prevent self-delete: `if (req.params.id === request.user.user_id) → 400`
- Optional: prevent deleting the last admin (could lock everyone out
  of an org).

**Organization hard delete**: `DELETE /organizations/:id/permanent` (admin only)

What it removes:
- `organizations` row
- All `memberships` for this org
- All `inventory` rows for this org
- All `orders` rows for this org
- All `inventory_uploads`, `order_uploads` rows for this org
- All `activity_log` rows for this org (org is the audit scope; no
  cross-org audit history exists for a deleted org)

Pre-flight safety check:
- Prevent deletion of the org the requesting admin is currently
  signed into (forces a switch first).
- Return 400 with a clear message if any active mutating uploads are
  in-flight for the org (acquire-once flag during upload).

### Implementation steps
1. **Backend routes**:
   - `server/src/routes/users.js` — add `DELETE /:id/permanent`.
   - `server/src/routes/organizations.js` — add `DELETE /:id/permanent`.
   - Both behind `requireRole('admin')` + double-confirmation header
     `X-Confirm-Delete: <username|slug>` matching the URL param.
2. **Service methods**:
   - `usersService.hardDeleteUser(userId, requestingUserId)`
   - Each implements the cascade above as a sequence of DELETE/UPDATE
     calls. Wrap in a try/catch with rollback log if any step fails
     (BigQuery has no transactions across queries; each DML is
     individually atomic — log enough to manually reconcile if a
     mid-cascade failure occurs).
3. **Repo methods**:
   - `usersRepo.deletePermanent(userId)`
   - `usersRepo.nullifyAuditReferences(userId)` — UPDATE inventory /
     orders / activity_log SET user_id = NULL WHERE user_id = @x.
   - `orgsRepo.deletePermanent(organizationId)`
   - `inventoryRepo.deleteAllForOrg`, `ordersRepo.deleteAllForOrg`,
     `uploadsRepo.deleteAllForOrg`, `activityRepo.deleteAllForOrg`.
4. **Frontend**:
   - [js/app.js](../js/app.js) Settings page — add overflow menu with
     Delete entry per row.
   - Build a `Modal.dangerDelete(prompt, expectedText)` helper in
     [js/utilities.js](../js/utilities.js) for the typed-confirmation modal.
   - Wire to the new API client methods `API.deleteUserPermanent(id)`
     and `API.deleteOrgPermanent(id)`.
5. **Auditing**:
   - Log a final `activity_log` entry (user_id = requesting admin,
     description = "Permanently deleted user/org X") BEFORE the cascade
     runs, so the action survives the org/user it destroyed.

### Pitfalls to avoid
- Don't soft-delete instead of hard-delete when the user explicitly
  picks hard delete. The whole point is the rows actually disappear.
- BigQuery's streaming-insert buffer can block DELETE for ~90 minutes
  on recently-streamed rows. Activity log is currently streaming
  (see M4); switch that to DML INSERT first or document the buffer
  delay in the UI ("Audit entries from the last hour may take up to
  90 minutes to be removed").
- Make sure the cascade DELETEs are ordered: child tables first
  (memberships, inventory, orders) then the parent (org). Otherwise
  foreign-key-style integrity checks (when added later) would block.
- Never expose hard-delete to anything below `admin` role. Even a
  manager seeing the Delete button by mistake is a UX failure.

### Test plan
1. Create a test user + test org. Add some inventory + orders + activity.
2. From a different admin's session, hard-delete the test user — verify
   the user is gone, the `activity_log` rows still exist with `user_id =
   NULL`, and the user can no longer log in.
3. Hard-delete the test org — verify all inventory, orders, uploads,
   memberships, activity rows for that org are gone. Verify other orgs'
   data is untouched (org isolation under deletion).
4. Try to hard-delete the currently-signed-in admin's own user — must
   be rejected with 400.
5. Try to hard-delete the currently-active org — must be rejected.

### Why this isn't a quick win
- ~6 new repo methods, 2 new service methods, 2 new routes, 1 new
  modal pattern, 2 frontend wiring points.
- Touches the most destructive operations in the platform; bugs here
  could nuke production data. Must ship with a test plan executed
  against a staging environment first.
- Estimated effort: 0.5–1 day of focused work.

---

---

## Box Lookup architecture decision (LANDED 2026-05-17)

### Problem
`WHERE organization_id = @x AND (LOWER(TRIM(upc)) = LOWER(TRIM(@q)) OR LOWER(TRIM(part_number)) = LOWER(TRIM(@q)))` had two issues:
1. **`LOWER(TRIM())` defeated clustering** — even with `CLUSTER BY org,
   upc`, the wrapped expression cannot be mapped back to block-level
   min/max stats, so BigQuery reverted to full org-slice scan.
2. **OR over two columns** — even with literal equality, only ONE of
   the two columns could be clustered. Whichever path wasn't clustered
   would scan the org's full slice.

### Options evaluated
- **A. Keep `CLUSTER BY org, upc`** — UPC search fast, part search slow.
- **B. `CLUSTER BY org, part_number`** — mirror of A; just shifts the
  problem to UPC.
- **C. `CLUSTER BY org, upc, part_number`** — BigQuery clustering is
  LEFT-PREFIX. The third key only fires when both preceding keys are
  bound. For an OR predicate, it never fires. Wasted cluster slot.
- **D. Split tables: `box_summary_by_upc` + `box_summary_by_part`** —
  two narrow tables, each clustered for ONE access pattern. Both
  searches hit ~10 KB scans regardless of org size. ← CHOSEN
- **E. Two queries against one table** — UPC branch gets clustering;
  part branch still full-scans. 2× latency for half the benefit.

### Why D won
- **Symmetric latency**: UPC and part lookups both sub-50ms regardless
  of which is more common per-org. Operationally important — you can't
  predict which identifier the operator has in hand.
- **2× storage cost is trivial** at box-summary grain (small per org).
- **2× refresh write cost** is on the fire-and-forget path that already
  doesn't block the originating mutation. Wall-clock per org ~3s → ~3.5s.
- **Routing complexity** is one regex
  (`/^\d{8,14}$/`) and a fallback rule, codified once in
  `lookupRepository`.
- **Schema migrations** affect two tables instead of one — acceptable
  given the perf win.

### What did NOT influence the choice
- **Future autocomplete/fuzzy search** — BigQuery clustering doesn't
  help prefix or trigram matching anyway. Those features will need a
  separate architectural call (BQ `SEARCH()` indexes, Algolia, or
  equivalent). Not letting it bias the clustering decision now.
- **"Millions of rows"** — even at 100k box-rows per org, an
  unclustered org-slice scan is only ~10 MB. The latency win (150ms →
  50ms) matters more than the $ savings.

### Implementation references
- DDL: [server/sql/migrations/20260517_002_materialized_summaries.sql](../server/sql/migrations/20260517_002_materialized_summaries.sql)
- Refresh: [server/src/services/summaryRefreshService.js](../server/src/services/summaryRefreshService.js) `_rebuildBoxSummary`
- Read: [server/src/repositories/lookupRepository.js](../server/src/repositories/lookupRepository.js)

### Upgrade note for ops
If an earlier revision of the materialized summaries migration was run
and created a single `box_summary` table, drop it manually after
deploying the new code:

```sql
DROP TABLE IF EXISTS `patman-inventory.patman_inventory.box_summary`;
```

`summaryRefreshService` rebuilds both new tables from raw on the next
mutating operation per org. No data loss.

---

### M4: activity log
[server/src/repositories/activityRepository.js:28](../server/src/repositories/activityRepository.js#L28)

Currently uses `dataset.table('activity_log').insert([row])` — streaming
inserts API. Costs more per row than DML and has a 90-min buffer that
delays UPDATEs/DELETEs against recent rows.

Fix:
1. Migration: rebuild `activity_log` with
   `PARTITION BY DATE(created_at) CLUSTER BY organization_id, action_type`.
2. Switch `activityRepository.log` to DML INSERT (mirror
   `uploadsRepository.insertOrdersBatch` pattern).
3. Verify cost dashboard shows the drop (typically ~70%).
