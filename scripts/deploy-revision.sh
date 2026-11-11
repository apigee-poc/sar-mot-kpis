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
curl -sS --fail-with-body -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Length: 0" \
  "https://apigee.googleapis.com/v1/organizations/${ORG}/environments/${ENV}/apis/${PROXY}/revisions/${REV}/deployments?override=true&serviceAccount=${SA}" \
  > /dev/null
echo "Deployment requested"
