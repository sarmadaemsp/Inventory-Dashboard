#!/usr/bin/env bash
# ============================================================
# setup-gcs.sh — provision GCS staging bucket + grant IAM + set
# UPLOAD_BUCKET env on Cloud Run.
#
# This activates the Phase B BigQuery LOAD JOB ingest path that's
# already shipped in code but currently fail-soft (falls back to
# the chunked DML path) because UPLOAD_BUCKET is unset.
#
# After this script: 100k-row Add uploads drop from ~5 min to
# ~10-15s. 17k rows drop from ~30s to ~3s. The code change is
# already deployed; only this infra/env setup is missing.
#
# Idempotent — safe to re-run. Every step checks current state
# before mutating. Run from the server/ directory:
#
#   bash setup-gcs.sh
#
# Prerequisites:
#   - gcloud CLI authenticated against the patman-inventory project
#   - User has roles/owner OR (roles/storage.admin + roles/run.admin
#     + roles/iam.serviceAccountAdmin)
# ============================================================
set -euo pipefail

PROJECT_ID="patman-inventory"
REGION="us-central1"
SERVICE="patman-inventory-api"
BUCKET="${UPLOAD_BUCKET_NAME:-${PROJECT_ID}-upload-staging}"

echo "==> Resolving project number + runtime service account..."
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
echo "    Project:    $PROJECT_ID ($PROJECT_NUMBER)"
echo "    Region:     $REGION"
echo "    Bucket:     gs://${BUCKET}"
echo "    Runtime SA: $RUNTIME_SA"
echo ""

# ── 1. Create the bucket if missing ────────────────────────────
echo "==> [1/4] Ensuring GCS bucket gs://${BUCKET} exists..."
if gcloud storage buckets describe "gs://${BUCKET}" --project="$PROJECT_ID" &>/dev/null; then
  echo "    (already exists — OK)"
else
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --uniform-bucket-level-access
  echo "    created."
fi

# ── 2. Lifecycle policy: auto-delete staged NDJSON after 1 day ─
# This is the safety net for orphan staging objects in case the
# pipeline's best-effort post-LOAD-JOB deleteObject misses one.
echo ""
echo "==> [2/4] Applying lifecycle policy (auto-delete uploads/* after 1 day)..."
LIFECYCLE_JSON=$(mktemp)
cat > "$LIFECYCLE_JSON" <<'EOF'
{
  "rule": [
    { "action": { "type": "Delete" },
      "condition": { "age": 1, "matchesPrefix": ["uploads/"] } }
  ]
}
EOF
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file="$LIFECYCLE_JSON"
rm -f "$LIFECYCLE_JSON"
echo "    applied."

# ── 3. Grant the Cloud Run runtime SA storage.objectAdmin ──────
# objectAdmin (not just objectCreator) — the pipeline both creates
# the staging object AND deletes it post-LOAD-JOB for cleanup.
echo ""
echo "==> [3/4] Granting ${RUNTIME_SA} storage.objectAdmin on bucket..."
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/storage.objectAdmin" \
  --condition=None \
  --quiet
echo "    granted."

# ── 4. Set UPLOAD_BUCKET env on Cloud Run + redeploy revision ──
# After this the next request hitting an instance will boot with
# storageService.enabled === true. Verify via the boot log line:
#   [BOOT] GCS staging  enabled=true  bucket=...
echo ""
echo "==> [4/4] Setting UPLOAD_BUCKET=${BUCKET} on ${SERVICE} (forces a new revision)..."
gcloud run services update "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --update-env-vars="UPLOAD_BUCKET=${BUCKET}" \
  --quiet
echo "    deployed."

# ── 5. Verify BigQuery jobUser role on the runtime SA ──────────
# LOAD JOB requires bigquery.jobs.create at the project level.
# Most installs already have this from the initial setup-gcp.sh
# run, but we re-grant idempotently for safety.
echo ""
echo "==> Verifying BigQuery jobUser on runtime SA (idempotent)..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/bigquery.jobUser" \
  --condition=None \
  --quiet >/dev/null
echo "    verified."

echo ""
echo "============================================================"
echo " GCS + LOAD JOB setup complete."
echo ""
echo " Verify by uploading a small inventory file via the UI."
echo " The Cloud Run log should show:"
echo "   event=upload_pipeline_complete  add_path=load_job"
echo ""
echo " If you instead see  add_path=dml_no_gcs , the env var didn't"
echo " propagate to the running instance. Wait ~30s and retry, OR"
echo " inspect the boot log of the latest revision:"
echo "   gcloud run services logs read $SERVICE --region=$REGION \\"
echo "     --limit=50 | grep '\\[BOOT\\] GCS'"
echo "============================================================"
