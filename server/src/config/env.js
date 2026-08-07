import 'dotenv/config';

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name, defaultValue = '') {
  return process.env[name] ?? defaultValue;
}

export const env = {
  PORT:     parseInt(optional('PORT', '8080'), 10),
  NODE_ENV: optional('NODE_ENV', 'development'),

  GCP_PROJECT_ID: required('GCP_PROJECT_ID'),

  JWT_SECRET:          required('JWT_SECRET'),
  JWT_ACCESS_EXPIRES:  optional('JWT_ACCESS_EXPIRES',  '2h'),
  // Refresh-token TTL splits along the "Remember this device" flag:
  //   - Unchecked       → JWT_REFRESH_EXPIRES           (7d default)
  //   - Checked         → JWT_REFRESH_EXPIRES_REMEMBERED (30d default)
  // Hard re-login is required at expiry — no sliding window.
  JWT_REFRESH_EXPIRES:           optional('JWT_REFRESH_EXPIRES',           '7d'),
  JWT_REFRESH_EXPIRES_REMEMBERED: optional('JWT_REFRESH_EXPIRES_REMEMBERED', '30d'),

  LOG_LEVEL: optional('LOG_LEVEL', 'info'),

  // Comma-separated list of EXTRA allowed origins. The production
  // GitHub Pages frontend is hardcoded in server.js so it cannot be
  // dropped by a missing/misconfigured Cloud Run env var. Use this
  // env for dev (e.g. http://localhost:3000) or preview deployments.
  // The literal string '*' enables the dev-only wildcard.
  CORS_ORIGIN: optional('CORS_ORIGIN', '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // ── Cloud Tasks (Phase A async upload lifecycle) ───────────────────
  // All four must be set for Cloud Tasks to be active. When any is
  // missing, cloudTasksService runs the summary refresh inline as a
  // fallback (same correctness, just no out-of-band scheduling). This
  // means the backend ships and works BEFORE the operator creates the
  // queue — uploads still return 202 + run Phase 2-4 in background;
  // the only difference is the refresh runs in the same Node task
  // instead of a separate Cloud Run invocation.
  //
  //   TASKS_LOCATION    — Cloud Tasks region (e.g. us-central1)
  //   TASKS_QUEUE_NAME  — queue name (e.g. patman-summary-refresh)
  //   WORKER_BASE_URL   — canonical Cloud Run URL of THIS service
  //                       (used as the task's HTTP target + OIDC audience)
  //   TASKS_INVOKER_SA  — service account email that signs the task's
  //                       OIDC token. Must have roles/run.invoker on
  //                       this Cloud Run service.
  TASKS_LOCATION:   optional('TASKS_LOCATION',   ''),
  TASKS_QUEUE_NAME: optional('TASKS_QUEUE_NAME', ''),
  WORKER_BASE_URL:  optional('WORKER_BASE_URL',  ''),
  TASKS_INVOKER_SA: optional('TASKS_INVOKER_SA', ''),

  // ── Retention purge PIN gate ─────────────────────────────────────
  // Small friction PIN required by /admin/purge-old-data. Not a
  // cryptographic secret — a short gate so the destructive action
  // can't be triggered by accident even with a stolen admin JWT.
  // Defaults to '1224' for zero-touch operation; can be rotated on
  // Cloud Run by setting RETENTION_PIN.
  RETENTION_PIN: optional('RETENTION_PIN', '1224'),

  // ── GCS staging bucket (Phase B BigQuery LOAD JOB ingest) ────────
  // When set, the upload Add path stages parsed rows as NDJSON to
  //   gs://${UPLOAD_BUCKET}/uploads/${upload_id}/{inventory|orders}-adds.ndjson
  // and runs a single BigQuery LOAD JOB instead of the chunked DML
  // INSERTs (which take ~5 minutes for 100k rows). When unset, the
  // pipeline falls back to the pure DML path — same correctness,
  // slower. Bucket setup steps live in docs/AUDIT_FOLLOWUP.md.
  UPLOAD_BUCKET: optional('UPLOAD_BUCKET', ''),
};
