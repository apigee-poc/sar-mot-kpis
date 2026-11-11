#!/usr/bin/env bash
# Creates required service accounts and IAM bindings for SAR MOT KPIs non-prod.
# Usage: 02-service-accounts-iam.sh [env_file]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-${SCRIPT_DIR}/env/nonprod.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${ENV_FILE}"

echo "============================================================"
echo "Configuring Service Accounts and IAM in project: ${PROJECT_ID}"
echo "============================================================"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
APIGEE_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-apigee.iam.gserviceaccount.com"

echo "Project ID: ${PROJECT_ID}"
echo "Project Number: ${PROJECT_NUMBER}"
echo "Apigee Service Agent: ${APIGEE_SERVICE_AGENT}"

# 1. Create sa-kpi-proxy-runtime if missing
PROXY_RUNTIME_EMAIL="${PROXY_RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "${PROXY_RUNTIME_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Service account ${PROXY_RUNTIME_EMAIL} already exists."
else
  echo "Creating service account ${PROXY_RUNTIME_EMAIL}..."
  gcloud iam service-accounts create "${PROXY_RUNTIME_SA}" \
    --display-name="SAR MOT KPIs Proxy Runtime (Apigee to Integration)" \
    --project="${PROJECT_ID}" \
    --quiet
fi

# 2. Create sa-kpi-connector if missing
CONNECTOR_EMAIL="${CONNECTOR_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "${CONNECTOR_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Service account ${CONNECTOR_EMAIL} already exists."
else
  echo "Creating service account ${CONNECTOR_EMAIL}..."
  gcloud iam service-accounts create "${CONNECTOR_SA}" \
    --display-name="SAR MOT KPIs Connector Runtime (Connection to Cloud SQL)" \
    --project="${PROJECT_ID}" \
    --quiet
fi

# 3. Grant sa-kpi-proxy-runtime roles/integrations.integrationInvoker on the project
echo "Granting roles/integrations.integrationInvoker to ${PROXY_RUNTIME_EMAIL}..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${PROXY_RUNTIME_EMAIL}" \
  --role="roles/integrations.integrationInvoker" \
  --condition=None \
  --quiet >/dev/null

# 4. Grant Apigee service agent permission to create tokens on sa-kpi-proxy-runtime
echo "Granting roles/iam.serviceAccountTokenCreator to Apigee Service Agent on ${PROXY_RUNTIME_EMAIL}..."
gcloud iam service-accounts add-iam-policy-binding "${PROXY_RUNTIME_EMAIL}" \
  --member="serviceAccount:${APIGEE_SERVICE_AGENT}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project="${PROJECT_ID}" \
  --quiet >/dev/null

# 5. Grant cb-deploy-nonprod roles in apigee-nonprod-511322
echo "Granting deployment roles to ${CB_DEPLOY_SA}..."

# Integration Admin (publish / manage integrations)
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CB_DEPLOY_SA}" \
  --role="roles/integrations.integrationAdmin" \
  --condition=None \
  --quiet >/dev/null

# Connectors Admin (manage connections and endpoint attachments)
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CB_DEPLOY_SA}" \
  --role="roles/connectors.admin" \
  --condition=None \
  --quiet >/dev/null

# Cloud SQL Admin (for database creation and gcloud sql import)
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${CB_DEPLOY_SA}" \
  --role="roles/cloudsql.admin" \
  --condition=None \
  --quiet >/dev/null

# Service Account User on sa-kpi-proxy-runtime
gcloud iam service-accounts add-iam-policy-binding "${PROXY_RUNTIME_EMAIL}" \
  --member="serviceAccount:${CB_DEPLOY_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --project="${PROJECT_ID}" \
  --quiet >/dev/null

# Service Account User on sa-kpi-connector
gcloud iam service-accounts add-iam-policy-binding "${CONNECTOR_EMAIL}" \
  --member="serviceAccount:${CB_DEPLOY_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --project="${PROJECT_ID}" \
  --quiet >/dev/null

# 6. Bind secretAccessor on DB secret if secret exists
if gcloud secrets describe "${DB_SECRET_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Granting roles/secretmanager.secretAccessor on secret ${DB_SECRET_NAME} to ${CONNECTOR_EMAIL}..."
  gcloud secrets add-iam-policy-binding "${DB_SECRET_NAME}" \
    --member="serviceAccount:${CONNECTOR_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="${PROJECT_ID}" \
    --quiet >/dev/null
else
  echo "Secret '${DB_SECRET_NAME}' does not exist yet; secret-level binding will be applied in Phase P2."
fi

# 7. Bind storage.objectAdmin on seed bucket if bucket exists
if gcloud storage buckets describe "gs://${SEED_BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Granting roles/storage.objectAdmin on gs://${SEED_BUCKET} to ${CB_DEPLOY_SA}..."
  gcloud storage buckets add-iam-policy-binding "gs://${SEED_BUCKET}" \
    --member="serviceAccount:${CB_DEPLOY_SA}" \
    --role="roles/storage.objectAdmin" \
    --quiet >/dev/null
else
  echo "Seed bucket 'gs://${SEED_BUCKET}' does not exist yet; bucket-level binding will be applied in Phase P2."
fi

echo "============================================================"
echo "SUCCESS: Service accounts and IAM bindings applied."
echo "============================================================"
