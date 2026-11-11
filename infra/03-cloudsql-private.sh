#!/usr/bin/env bash
# Creates Cloud SQL private instance, databases, user, secret and seed bucket.
# Usage: 03-cloudsql-private.sh [env_file]
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
echo "Creating Private Cloud SQL Instance in ${PROJECT_ID}"
echo "============================================================"
echo "Instance:  ${SQL_INSTANCE}"
echo "Region:    ${REGION}"
echo "Version:   ${SQL_VERSION}"
echo "Tier:      ${SQL_TIER}"
echo "Databases: ${DB_DEV}, ${DB_STAGING}"
echo "PSC Allowed: ${PROJECT_ID},${CI_CD_PROJECT_ID}"

# 1. Create Cloud SQL instance if not exists
if gcloud sql instances describe "${SQL_INSTANCE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Cloud SQL instance ${SQL_INSTANCE} already exists."
else
  echo "Creating Cloud SQL instance ${SQL_INSTANCE} (private via PSC, no public IP)..."
  gcloud sql instances create "${SQL_INSTANCE}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --database-version="${SQL_VERSION}" \
    --tier="${SQL_TIER}" \
    --enable-private-service-connect \
    --allowed-psc-projects="${PROJECT_ID},${CI_CD_PROJECT_ID}" \
    --no-assign-ip \
    --storage-size=10GB \
    --storage-type=SSD \
    --storage-auto-increase \
    --quiet
  echo "Cloud SQL instance created."
fi

# 2. Create databases
for DB in "${DB_DEV}" "${DB_STAGING}"; do
  if gcloud sql databases describe "${DB}" --instance="${SQL_INSTANCE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "Database ${DB} already exists."
  else
    echo "Creating database ${DB}..."
    gcloud sql databases create "${DB}" --instance="${SQL_INSTANCE}" --project="${PROJECT_ID}" --quiet
  fi
done

# 3. Create or update user kpi_reader with generated password stored in Secret Manager
echo "Managing user '${DB_USER}' and Secret Manager secret '${DB_SECRET_NAME}'..."
if ! gcloud secrets describe "${DB_SECRET_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Creating Secret Manager secret ${DB_SECRET_NAME}..."
  gcloud secrets create "${DB_SECRET_NAME}" \
    --replication-policy="automatic" \
    --project="${PROJECT_ID}" \
    --quiet
fi

# Check if secret already has a version
HAS_SECRET_VERSION="false"
if gcloud secrets versions list "${DB_SECRET_NAME}" --project="${PROJECT_ID}" --filter="state:ENABLED" --format='value(name)' | grep -q '^[0-9]'; then
  HAS_SECRET_VERSION="true"
fi

if [[ "${HAS_SECRET_VERSION}" == "false" ]]; then
  echo "Generating new random password for ${DB_USER}..."
  DB_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 20)"
  echo -n "${DB_PASSWORD}" | gcloud secrets versions add "${DB_SECRET_NAME}" \
    --data-file=- \
    --project="${PROJECT_ID}" \
    --quiet
  
  if gcloud sql users list --instance="${SQL_INSTANCE}" --project="${PROJECT_ID}" --format='value(name)' | grep -q "^${DB_USER}$"; then
    echo -n "${DB_PASSWORD}" | gcloud sql users set-password "${DB_USER}" \
      --instance="${SQL_INSTANCE}" \
      --project="${PROJECT_ID}" \
      --password=- \
      --quiet
  else
    echo -n "${DB_PASSWORD}" | gcloud sql users create "${DB_USER}" \
      --instance="${SQL_INSTANCE}" \
      --project="${PROJECT_ID}" \
      --password=- \
      --quiet
  fi
  unset DB_PASSWORD
  echo "Password generated, saved to Secret Manager, and applied to Cloud SQL user."
else
  echo "Secret ${DB_SECRET_NAME} already has an active version; preserving existing credentials."
  # Ensure user exists in Cloud SQL using existing secret version
  if ! gcloud sql users list --instance="${SQL_INSTANCE}" --project="${PROJECT_ID}" --format='value(name)' | grep -q "^${DB_USER}$"; then
    gcloud secrets versions access latest --secret="${DB_SECRET_NAME}" --project="${PROJECT_ID}" \
      | gcloud sql users create "${DB_USER}" --instance="${SQL_INSTANCE}" --project="${PROJECT_ID}" --password=- --quiet
  fi
fi

# 4. Grant sa-kpi-connector secretAccessor and viewer on DB password secret
CONNECTOR_EMAIL="${CONNECTOR_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
echo "Granting secret permissions on ${DB_SECRET_NAME} to ${CONNECTOR_EMAIL}..."
gcloud secrets add-iam-policy-binding "${DB_SECRET_NAME}" \
  --member="serviceAccount:${CONNECTOR_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --project="${PROJECT_ID}" \
  --quiet >/dev/null
gcloud secrets add-iam-policy-binding "${DB_SECRET_NAME}" \
  --member="serviceAccount:${CONNECTOR_EMAIL}" \
  --role="roles/secretmanager.viewer" \
  --project="${PROJECT_ID}" \
  --quiet >/dev/null

# 5. Create seed GCS bucket
if gcloud storage buckets describe "gs://${SEED_BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Bucket gs://${SEED_BUCKET} already exists."
else
  echo "Creating bucket gs://${SEED_BUCKET}..."
  gcloud storage buckets create "gs://${SEED_BUCKET}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --uniform-bucket-level-access \
    --quiet
fi

# 6. Grant Cloud SQL service account read access to seed bucket
SQL_SA="$(gcloud sql instances describe "${SQL_INSTANCE}" --project="${PROJECT_ID}" --format='value(serviceAccountEmailAddress)')"
echo "Granting roles/storage.objectViewer on gs://${SEED_BUCKET} to Cloud SQL SA (${SQL_SA})..."
gcloud storage buckets add-iam-policy-binding "gs://${SEED_BUCKET}" \
  --member="serviceAccount:${SQL_SA}" \
  --role="roles/storage.objectViewer" \
  --quiet >/dev/null

# 7. Grant cb-deploy-nonprod objectAdmin on seed bucket
echo "Granting roles/storage.objectAdmin on gs://${SEED_BUCKET} to ${CB_DEPLOY_SA}..."
gcloud storage buckets add-iam-policy-binding "gs://${SEED_BUCKET}" \
  --member="serviceAccount:${CB_DEPLOY_SA}" \
  --role="roles/storage.objectAdmin" \
  --quiet >/dev/null

# Print PSC Service Attachment for reference (needed in P3)
PSC_SA_LINK="$(gcloud sql instances describe "${SQL_INSTANCE}" --project="${PROJECT_ID}" --format='value(pscServiceAttachmentLink)')"
echo "============================================================"
echo "SUCCESS: Cloud SQL instance configured."
echo "PSC Service Attachment: ${PSC_SA_LINK}"
echo "============================================================"
