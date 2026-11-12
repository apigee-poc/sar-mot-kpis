#!/usr/bin/env bash
# Creates the Integration Connectors PSC endpoint attachment targeting Cloud SQL.
# Usage: 04-psc-endpoint-attachment.sh [env_file]
# PROD ONLY (IS_PROD=1 from infra/lib/guard.sh, i.e. prod.env inside Cloud Build with TARGET=prod, P8):
#   - before the attachment is created, the Integration Connectors runtime tenant project
#     (scripts/lib/connectors-tenant.sh, runtimeConfig.serviceDirectory) is added to the Cloud SQL
#     instance's --allowed-psc-projects if it is missing (D18/D19; the existing list is kept);
#   - at the end the attachment must reach state ACCEPTED with an endpoint IP (polled up to
#     ~5 min), else exit 1.
# Non-prod (nonprod.env) behaviour is unchanged. integrationcli: PATH, else /workspace/bin
# (scripts/install-integrationcli.sh).
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

# Prod guard (AGENTS.md rule 2, P8): prod only inside Cloud Build with TARGET=prod; refuses a
# TARGET/project mismatch. Runs before any gcloud call.
# shellcheck source=lib/guard.sh
source "${SCRIPT_DIR}/lib/guard.sh"
infra_guard "$(basename "${BASH_SOURCE[0]}")"

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

# 1b. (prod.env) Allow-list the Connectors tenant project on the Cloud SQL PSC consumer list.
if [[ "${IS_PROD}" == "1" ]]; then
  # shellcheck source=../scripts/lib/connectors-tenant.sh
  source "${REPO_ROOT}/scripts/lib/connectors-tenant.sh"
  TENANT_PROJECT="$(resolve_connectors_tenant "${PROJECT_ID}" "${REGION}" "${TOKEN}")"
  echo "Integration Connectors tenant project: ${TENANT_PROJECT}"
  ALLOWED="$(gcloud sql instances describe "${SQL_INSTANCE}" --project="${PROJECT_ID}" \
    --format='value(settings.ipConfiguration.pscConfig.allowedConsumerProjects)' --quiet)"
  ALLOWED="$(printf '%s' "${ALLOWED}" | tr ';' ',' | tr -d '\r\n[:space:]')"
  echo "Current --allowed-psc-projects: ${ALLOWED:-<none>}"
  case ",${ALLOWED}," in
    *",${TENANT_PROJECT},"*)
      echo "Tenant project ${TENANT_PROJECT} is already allowed."
      ;;
    *)
      NEW_ALLOWED="${ALLOWED:+${ALLOWED},}${TENANT_PROJECT}"
      echo "Patching ${SQL_INSTANCE} --allowed-psc-projects=${NEW_ALLOWED} (the flag replaces the list)..."
      gcloud sql instances patch "${SQL_INSTANCE}" \
        --project="${PROJECT_ID}" \
        --allowed-psc-projects="${NEW_ALLOWED}" \
        --quiet
      ;;
  esac
fi

# 2. Check if Endpoint Attachment already exists
API="https://connectors.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/endpointAttachments/${PSC_ENDPOINT_ATTACHMENT}"
HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${API}")"

if [[ "${HTTP_CODE}" == "200" ]]; then
  echo "Endpoint Attachment ${PSC_ENDPOINT_ATTACHMENT} already exists."
else
  echo "Creating Endpoint Attachment ${PSC_ENDPOINT_ATTACHMENT}..."
  if command -v integrationcli >/dev/null 2>&1; then
    CLI="integrationcli"
  elif [[ -x /workspace/bin/integrationcli ]]; then
    CLI="/workspace/bin/integrationcli"
  else
    echo "ERROR: integrationcli not found on PATH or at /workspace/bin/integrationcli (scripts/install-integrationcli.sh)." >&2
    exit 1
  fi
  "${CLI}" endpoints create \
    -n "${PSC_ENDPOINT_ATTACHMENT}" \
    -s "${PSC_SA_LINK}" \
    -p "${PROJECT_ID}" \
    -r "${REGION}" \
    -t "${TOKEN}" \
    --wait
  echo "Endpoint Attachment created."
fi

# 3. Verify state
if [[ "${IS_PROD}" == "1" ]]; then
  # (prod.env) Fail unless ACCEPTED with an endpoint IP. The state is returned in the FULL view
  # only (Connectors v1 REST reference: EndpointAttachmentView ENDPOINT_ATTACHMENT_VIEW_FULL).
  STATE=""; EP_IP=""
  for _ in $(seq 1 30); do
    EA_JSON="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${API}?view=ENDPOINT_ATTACHMENT_VIEW_FULL" | tr -d '\r\n' || true)"
    STATE="$(printf '%s' "${EA_JSON}" | grep -o '"state"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)"
    EP_IP="$(printf '%s' "${EA_JSON}" | grep -o '"endpointIp"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)"
    echo "Endpoint Attachment state: ${STATE:-UNKNOWN}, endpointIp: ${EP_IP:-<none>}"
    if [[ "${STATE}" == "ACCEPTED" && -n "${EP_IP}" ]]; then
      break
    fi
    case "${STATE}" in
      REJECTED|CLOSED|FROZEN|NEEDS_ATTENTION|ACCEPTED_NOT_PROGRAMMED)
        echo "ERROR: endpoint attachment ${PSC_ENDPOINT_ATTACHMENT} is ${STATE} (is the Connectors tenant project allowed on ${SQL_INSTANCE}?)." >&2
        exit 1
        ;;
    esac
    sleep 10
  done
  if [[ "${STATE}" != "ACCEPTED" || -z "${EP_IP}" ]]; then
    echo "ERROR: endpoint attachment ${PSC_ENDPOINT_ATTACHMENT} did not reach ACCEPTED with an endpoint IP." >&2
    exit 1
  fi
fi
# Non-prod: the legacy read (BASIC view, unchanged output). Prod: STATE is the ACCEPTED state the
# FULL-view loop above already verified, so it is not re-read in the BASIC view (P8 review L5).
if [[ "${IS_PROD}" != "1" ]]; then
  STATE="$(curl -s -H "Authorization: Bearer ${TOKEN}" "${API}" | grep -o '"state": *"[^"]*"' | cut -d'"' -f4 || echo "UNKNOWN")"
fi
echo "Endpoint Attachment State: ${STATE}"
echo "============================================================"
echo "SUCCESS: Endpoint Attachment ${PSC_ENDPOINT_ATTACHMENT} is ready."
echo "============================================================"
