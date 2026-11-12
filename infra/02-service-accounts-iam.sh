#!/usr/bin/env bash
# Creates required service accounts and IAM bindings for SAR MOT KPIs (non-prod, or prod with
# infra/env/prod.env inside Cloud Build with TARGET=prod: infra/lib/guard.sh, P8).
# Usage: 02-service-accounts-iam.sh [env_file]
# Exit: 0 all bindings applied; 3 everything else applied but the Application Integration service
# agent was missing (Quick setup not done, D28), the IAM policy or a Newman secret could not be
# read (permission/API error), or the connectors.invoker grant failed; other
# non-zero: a gcloud call failed (set -e).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-${SCRIPT_DIR}/env/nonprod.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${ENV_FILE}"

# Prod guard (AGENTS.md rule 2, P8): prod only inside Cloud Build with TARGET=prod; refuses a
# TARGET/project mismatch. Runs before any gcloud call.
# shellcheck source=lib/guard.sh
source "${SCRIPT_DIR}/lib/guard.sh"
infra_guard "$(basename "${BASH_SOURCE[0]}")"

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

# 4b. Grant the Application Integration service agent roles/connectors.invoker on the project.
# Without it, publishing an integration with a Connectors task fails with
# "Permission 'connectors.connections.get' denied" (D28). The agent exists only after
# Application Integration has been provisioned in the project/region (Console Quick setup, D28).
# Pre-check (M-5): the agent must already appear as a member in the project IAM policy (it holds
# roles/integrations.serviceAgent once provisioned; VERIFY on a freshly provisioned project).
# A missing agent or a failed grant does NOT stop the later grants; the script exits 3 at the end.
INTEGRATIONS_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-integrations.iam.gserviceaccount.com"
INCOMPLETE=""
# A failed policy read (e.g. 403, no resourcemanager.projects.getIamPolicy) is reported as such,
# not as "agent missing" (P7 final review M-5).
POLICY_READ_OK=1
if ! AGENT_IN_POLICY="$(gcloud projects get-iam-policy "${PROJECT_ID}" \
  --flatten="bindings[].members" \
  --filter="bindings.members:serviceAccount:${INTEGRATIONS_SERVICE_AGENT}" \
  --format="value(bindings.role)" \
  --quiet 2>/dev/null)"; then
  POLICY_READ_OK=0
  AGENT_IN_POLICY=""
fi
if [[ "${POLICY_READ_OK}" == "0" ]]; then
  echo "WARNING: could not read the IAM policy of ${PROJECT_ID} (permission denied or API error)," >&2
  echo "         so the Application Integration service agent could not be checked. Skipping roles/connectors.invoker." >&2
  INCOMPLETE="${INCOMPLETE} connectors.invoker(IAM policy not readable)"
elif [[ -z "${AGENT_IN_POLICY}" ]]; then
  echo "WARNING: Application Integration service agent ${INTEGRATIONS_SERVICE_AGENT} not found in the" >&2
  echo "         IAM policy of ${PROJECT_ID}. Provision Application Integration in ${REGION:-us-central1}" >&2
  echo "         with the Console Quick setup (D28), then re-run this script. Skipping roles/connectors.invoker." >&2
  INCOMPLETE="${INCOMPLETE} connectors.invoker(service agent missing)"
else
  echo "Granting roles/connectors.invoker to Application Integration Service Agent ${INTEGRATIONS_SERVICE_AGENT}..."
  if ! gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${INTEGRATIONS_SERVICE_AGENT}" \
    --role="roles/connectors.invoker" \
    --condition=None \
    --quiet >/dev/null; then
    echo "WARNING: granting roles/connectors.invoker to ${INTEGRATIONS_SERVICE_AGENT} failed; continuing." >&2
    INCOMPLETE="${INCOMPLETE} connectors.invoker(grant failed)"
  fi
fi

# 5. Grant the build SA (CB_DEPLOY_SA: cb-deploy-nonprod, or cb-deploy-prod with prod.env) its
# deployment roles in PROJECT_ID
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

# 5b. PROD ONLY (IS_PROD=1 from infra/lib/guard.sh, which also pins CB_DEPLOY_SA to
# cb-deploy-prod there): the Apigee deploy roles (proxy import/deploy, KVMs, debug mask;
# developerAdmin for the infra/06 developers and apps; VERIFY the minimal set on the first prod
# run). cb-deploy-nonprod got them from cicd-workspace, so non-prod runs are unchanged.
if [[ "${IS_PROD}" == "1" ]]; then
  for APIGEE_ROLE in roles/apigee.apiAdminV2 roles/apigee.environmentAdmin roles/apigee.developerAdmin; do
    echo "Granting ${APIGEE_ROLE} to ${CB_DEPLOY_SA}..."
    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${CB_DEPLOY_SA}" \
      --role="${APIGEE_ROLE}" \
      --condition=None \
      --quiet >/dev/null
  done
fi

# 6. Bind secretAccessor on DB secret if secret exists
if gcloud secrets describe "${DB_SECRET_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Granting roles/secretmanager.secretAccessor on secret ${DB_SECRET_NAME} to ${CONNECTOR_EMAIL}..."
  gcloud secrets add-iam-policy-binding "${DB_SECRET_NAME}" \
    --member="serviceAccount:${CONNECTOR_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="${PROJECT_ID}" \
    --quiet >/dev/null
  # 6b. PROD ONLY: scripts/create-connection.sh reads this secret's latest version METADATA (the
  # version number it references; never the payload): roles/secretmanager.viewer, secret-level.
  if [[ "${IS_PROD}" == "1" ]]; then
    echo "Granting roles/secretmanager.viewer on secret ${DB_SECRET_NAME} to ${CB_DEPLOY_SA}..."
    gcloud secrets add-iam-policy-binding "${DB_SECRET_NAME}" \
      --member="serviceAccount:${CB_DEPLOY_SA}" \
      --role="roles/secretmanager.viewer" \
      --project="${PROJECT_ID}" \
      --quiet >/dev/null
  fi
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

# 8. Let the build SA read the four Newman test-app secrets (P7: tests/run-newman.sh in Cloud
# Build). Secret-level bindings only, each applied only if the secret exists. infra/05 creates the
# secrets and grants the same access itself (D56), so a fresh 01..05 run is enough.
# NOT_FOUND means "not created yet"; any other describe error (e.g. 403) is reported as such and
# marks the run INCOMPLETE (M-5).
# PROD ONLY (IS_PROD=1): the list is NEWMAN_SECRETS from prod.env (the two smoke-app secrets;
# the MOT handover app's secrets are never readable by the build SA; infra/06 creates them).
# Non-prod: always the four non-prod secrets below (NEWMAN_SECRETS is ignored).
NEWMAN_SECRET_LIST=(sar-mot-poc-app-api-key sar-mot-poc-app-api-secret \
                    sar-mot-poc-other-app-api-key sar-mot-poc-other-app-api-secret)
NEWMAN_SECRET_CREATOR="infra/05"
if [[ "${IS_PROD}" == "1" ]]; then
  read -r -a NEWMAN_SECRET_LIST <<< "${NEWMAN_SECRETS:-}"
  if [[ ${#NEWMAN_SECRET_LIST[@]} -eq 0 ]]; then
    echo "ERROR: NEWMAN_SECRETS is not set in ${ENV_FILE}." >&2
    exit 1
  fi
  NEWMAN_SECRET_CREATOR="infra/06"
fi
for NEWMAN_SECRET in "${NEWMAN_SECRET_LIST[@]}"; do
  if DESCRIBE_ERR="$(gcloud secrets describe "${NEWMAN_SECRET}" --project="${PROJECT_ID}" --quiet 2>&1 >/dev/null)"; then
    echo "Granting roles/secretmanager.secretAccessor on secret ${NEWMAN_SECRET} to ${CB_DEPLOY_SA}..."
    gcloud secrets add-iam-policy-binding "${NEWMAN_SECRET}" \
      --member="serviceAccount:${CB_DEPLOY_SA}" \
      --role="roles/secretmanager.secretAccessor" \
      --project="${PROJECT_ID}" \
      --quiet >/dev/null
  elif [[ "${DESCRIBE_ERR}" == *NOT_FOUND* || "${DESCRIBE_ERR}" == *"not found"* ]]; then
    echo "Secret '${NEWMAN_SECRET}' does not exist yet; ${NEWMAN_SECRET_CREATOR} creates it and grants the access."
  else
    echo "WARNING: could not check secret '${NEWMAN_SECRET}' (permission denied or API error); skipping its grant." >&2
    INCOMPLETE="${INCOMPLETE} secretAccessor(${NEWMAN_SECRET}: not readable)"
  fi
done

# db/load.sh needs nothing more: cb-deploy has roles/cloudsql.admin (sql import) and
# roles/storage.objectAdmin on the seed bucket (step 7, D17); the Cloud SQL instance's own service
# account gets roles/storage.objectViewer on the bucket in infra/03.

if [[ -n "${INCOMPLETE}" ]]; then
  echo "============================================================" >&2
  echo "INCOMPLETE: all other bindings were applied, but not:${INCOMPLETE}" >&2
  echo "Fix the cause above (Quick setup D28, or the caller's permissions) and re-run this script (it is idempotent)." >&2
  echo "============================================================" >&2
  exit 3
fi

echo "============================================================"
echo "SUCCESS: Service accounts and IAM bindings applied."
echo "============================================================"
