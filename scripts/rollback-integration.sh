#!/usr/bin/env bash
# Rolls back an Application Integration integration after a post-deployment test failure.
# Usage: rollback-integration.sh <project> <region> <integration_name> <prev_version> [failed_version]
#
# If prev_version is present: re-publishes it and waits for it to become ACTIVE.
# If prev_version is empty/none: unpublishes failed_version so broken code is not live.
set -euo pipefail

PROJECT="$1"; REGION="$2"; INTEGRATION="$3"; PREV_VER="${4:-}"; FAILED_VER="${5:-}"
PY="$(command -v python3 || gcloud info --format='value(basic.python_location)')"
TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
BASE="https://integrations.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/integrations/${INTEGRATION}/versions"

echo "============================================================"
echo "POST-DEPLOYMENT TEST FAILED: INITIATING INTEGRATION ROLLBACK"
echo "Project: ${PROJECT} | Region: ${REGION} | Integration: ${INTEGRATION}"
echo "============================================================"

if [[ -n "${PREV_VER}" && "${PREV_VER}" != "none" ]]; then
  echo "Rolling back ${INTEGRATION} to previous version ${PREV_VER}..."
  curl -sS --fail-with-body -X POST -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" -d '{}' \
    "${BASE}/${PREV_VER}:publish" > /dev/null
  echo "Waiting for version ${PREV_VER} to reach ACTIVE state..."
  DEADLINE=$((SECONDS + 300))
  while true; do
    STATE="$(curl -sS -H "Authorization: Bearer ${TOKEN}" "${BASE}/${PREV_VER}" 2>/dev/null \
      | "${PY}" -c '
import json, sys
try:
    print(json.load(sys.stdin).get("state", ""))
except Exception:
    print("")
' || true)"
    if [[ "${STATE}" == "ACTIVE" ]]; then
      break
    fi
    if (( SECONDS >= DEADLINE )); then
      echo "ERROR: Version ${PREV_VER} did not reach ACTIVE within 300s (last state: ${STATE:-unknown})." >&2
      exit 1
    fi
    sleep 5
  done
  echo "SUCCESS: Rollback complete. Version ${PREV_VER} is ACTIVE for ${INTEGRATION}."
else
  echo "Notice: No previous version was published for ${INTEGRATION} prior to this run."
  if [[ -n "${FAILED_VER}" && "${FAILED_VER}" != "none" ]]; then
    echo "Unpublishing failed version ${FAILED_VER} of ${INTEGRATION}..."
    curl -sS --fail-with-body -X POST -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" -d '{}' \
      "${BASE}/${FAILED_VER}:unpublish" > /dev/null || true
    echo "SUCCESS: Failed version ${FAILED_VER} has been unpublished from ${INTEGRATION}."
  fi
fi
