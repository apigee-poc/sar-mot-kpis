#!/usr/bin/env bash
# Deploys an EXISTING revision of a proxy to an environment (no new import).
# Used to promote the revision that passed in dev to staging.
# Usage: deploy-revision.sh <org> <env> <proxy> <revision> [service_account]
set -euo pipefail

ORG="$1"; ENV="$2"; PROXY="$3"; REV="$4"
if [[ -z "${REV}" ]]; then
  echo "No revision given" >&2
  exit 1
fi

SA="${5:-sa-kpi-proxy-runtime@${ORG}.iam.gserviceaccount.com}"
TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
echo "Deploying ${PROXY} revision ${REV} to ${ENV} in ${ORG} (serviceAccount=${SA})"
# The API response goes to a temp file; on failure it is shown on stderr (it holds no secrets).
RESP="$(mktemp 2>/dev/null || echo "/tmp/deploy_resp_$$.json")"
trap 'rm -f "${RESP}"' EXIT
if ! curl -sS --fail-with-body -o "${RESP}" -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Length: 0" \
  "https://apigee.googleapis.com/v1/organizations/${ORG}/environments/${ENV}/apis/${PROXY}/revisions/${REV}/deployments?override=true&serviceAccount=${SA}"; then
  echo "ERROR: deployment request for ${PROXY} revision ${REV} to ${ENV} failed. API response:" >&2
  cat "${RESP}" >&2 || true
  echo "" >&2
  exit 1
fi
echo "Deployment requested"
