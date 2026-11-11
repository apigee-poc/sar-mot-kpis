#!/usr/bin/env bash
# Creates the Integration Connectors PSC endpoint attachment targeting Cloud SQL.
# Usage: 04-psc-endpoint-attachment.sh [env_file]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${1:-${SCRIPT_DIR}/env/nonprod.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${ENV_FILE}"

echo "============================================================"
echo "Creating PSC Endpoint Attachment in ${PROJECT_ID} (${REGION})"
echo "============================================================"

TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(echo "${TOKEN}" | tr -d '\r\n[:space:]')"

if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: Unable to acquire gcloud auth token" >&2
  exit 1
fi

# 1. Retrieve Cloud SQL PSC service attachment
echo "Fetching PSC service attachment from Cloud SQL instance ${SQL_INSTANCE}..."
PSC_SA_LINK="$(gcloud sql instances describe "${SQL_INSTANCE}" --project="${PROJECT_ID}" --format='value(pscServiceAttachmentLink)')"

if [[ -z "${PSC_SA_LINK}" ]]; then
  echo "ERROR: Could not retrieve PSC service attachment link from ${SQL_INSTANCE}." >&2
  exit 1
fi

echo "Target Service Attachment: ${PSC_SA_LINK}"

# 2. Check if Endpoint Attachment already exists
API="https://connectors.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/endpointAttachments/${PSC_ENDPOINT_ATTACHMENT}"
HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${API}")"

if [[ "${HTTP_CODE}" == "200" ]]; then
  echo "Endpoint Attachment ${PSC_ENDPOINT_ATTACHMENT} already exists."
else
  echo "Creating Endpoint Attachment ${PSC_ENDPOINT_ATTACHMENT}..."
  integrationcli endpoints create \
    -n "${PSC_ENDPOINT_ATTACHMENT}" \
    -s "${PSC_SA_LINK}" \
    -p "${PROJECT_ID}" \
    -r "${REGION}" \
    -t "${TOKEN}" \
    --wait
  echo "Endpoint Attachment created."
fi

# 3. Verify state
STATE="$(curl -s -H "Authorization: Bearer ${TOKEN}" "${API}" | grep -o '"state": *"[^"]*"' | cut -d'"' -f4 || echo "UNKNOWN")"
echo "Endpoint Attachment State: ${STATE}"
echo "============================================================"
echo "SUCCESS: Endpoint Attachment ${PSC_ENDPOINT_ATTACHMENT} is ready."
echo "============================================================"
