#!/usr/bin/env bash
# Enables all required Google Cloud APIs for SAR MOT KPIs.
# Usage: 01-enable-apis.sh [env_file]
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
echo "Enabling Google Cloud APIs for project: ${PROJECT_ID}"
echo "============================================================"

APIS=(
  "sqladmin.googleapis.com"
  "integrations.googleapis.com"
  "connectors.googleapis.com"
  "secretmanager.googleapis.com"
  "servicenetworking.googleapis.com"
  "compute.googleapis.com"
  "storage.googleapis.com"
  "cloudbuild.googleapis.com"
  "iam.googleapis.com"
  "apigee.googleapis.com"
)

echo "Target APIs: ${APIS[*]}"

gcloud services enable "${APIS[@]}" \
  --project="${PROJECT_ID}" \
  --quiet

echo "SUCCESS: All required APIs enabled in ${PROJECT_ID}."
