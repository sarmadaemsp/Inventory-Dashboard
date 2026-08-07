#!/usr/bin/env bash
# One-time GCP infrastructure setup for patman-inventory-api.
# Run from the server/ directory: bash setup-gcp.sh
set -euo pipefail

PROJECT_ID="patman-inventory"
REGION="us-central1"
REPO="patman-inventory"
SERVICE="patman-inventory-api"

echo "==> Resolving project number..."
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "    Project: $PROJECT_ID ($PROJECT_NUMBER)"
echo "    Cloud Build SA: $CLOUDBUILD_SA"
echo "    Cloud Run SA:   $COMPUTE_SA"

# ── APIs ────────────────────────────────────────────────────────────────────
echo ""
echo "==> Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  bigquery.googleapis.com \
  --project="$PROJECT_ID"

# ── Artifact Registry ────────────────────────────────────────────────────────
echo ""
echo "==> Creating Artifact Registry repository '$REPO' (skips if exists)..."
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --project="$PROJECT_ID" 2>/dev/null \
  || echo "    (already exists — OK)"

# ── Secrets ──────────────────────────────────────────────────────────────────
echo ""
echo "==> Creating JWT_SECRET in Secret Manager..."
echo "    Generate a 64-byte hex secret with:"
echo "    node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\""
echo ""
printf "    Paste JWT_SECRET value: "
read -rs JWT_SECRET_VALUE
echo ""

if gcloud secrets describe patman-jwt-secret --project="$PROJECT_ID" &>/dev/null; then
  echo "    Secret exists — adding new version..."
  echo -n "$JWT_SECRET_VALUE" | gcloud secrets versions add patman-jwt-secret \
    --data-file=- \
    --project="$PROJECT_ID"
else
  echo -n "$JWT_SECRET_VALUE" | gcloud secrets create patman-jwt-secret \
    --data-file=- \
    --project="$PROJECT_ID"
fi
echo "    patman-jwt-secret created/updated."

# ── IAM: Cloud Build SA ──────────────────────────────────────────────────────
echo ""
echo "==> Granting Cloud Build SA permissions..."

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$CLOUDBUILD_SA" \
  --role="roles/run.admin" \
  --condition=None --quiet

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$CLOUDBUILD_SA" \
  --role="roles/iam.serviceAccountUser" \
  --condition=None --quiet

gcloud secrets add-iam-policy-binding patman-jwt-secret \
  --member="serviceAccount:$CLOUDBUILD_SA" \
  --role="roles/secretmanager.secretAccessor" \
  --project="$PROJECT_ID"

echo "    Cloud Build SA grants applied."

# ── IAM: Cloud Run service account ──────────────────────────────────────────
echo ""
echo "==> Granting Cloud Run service account (default compute SA) permissions..."

# BigQuery: read-only at project level. Selective write access (hash upgrades)
# should be granted at dataset level via BigQuery dataset ACLs, not project IAM.
# See: bq update or Console → BigQuery → dataset → Sharing.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$COMPUTE_SA" \
  --role="roles/bigquery.dataViewer" \
  --condition=None --quiet

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$COMPUTE_SA" \
  --role="roles/bigquery.jobUser" \
  --condition=None --quiet

gcloud secrets add-iam-policy-binding patman-jwt-secret \
  --member="serviceAccount:$COMPUTE_SA" \
  --role="roles/secretmanager.secretAccessor" \
  --project="$PROJECT_ID"

echo "    Cloud Run SA grants applied."

echo ""
echo "  NOTE: password hash upgrades require dataset-level dataEditor on"
echo "  patman_inventory. Grant it after initial auth is verified:"
echo "    bq update --format=none patman-inventory:patman_inventory \\"
echo "      --table --add_access_group $COMPUTE_SA dataEditor"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo " Setup complete. Deploy with (from the server/ directory):"
echo ""
echo "   cd server"
echo "   gcloud builds submit . \\"
echo "     --config=cloudbuild.yaml \\"
echo "     --project=$PROJECT_ID"
echo ""
echo " Then get the service URL with:"
echo "   gcloud run services describe $SERVICE \\"
echo "     --region=$REGION \\"
echo "     --format='value(status.url)' \\"
echo "     --project=$PROJECT_ID"
echo ""
echo " Cut over frontend by setting CLOUD_RUN_URL in js/utilities.js"
echo "============================================================"
