#!/usr/bin/env bash
# Rolls back an Apigee proxy deployment after a post-deployment test failure.
# Usage: rollback.sh <org> <env> <proxy> <prev_revision> [failed_revision]
#
# If prev_revision is present: redeploys and waits for prev_revision to become READY.
# If prev_revision is empty/none: undeploys failed_revision so broken code is not live.
# Exit: 0 only when the redeploy/undeploy succeeded (SUCCESS is printed only then); non-zero when
# the redeploy, the wait or the undeploy call failed (P7 final review M-10), or when there is
# nothing to do because neither revision is known.
set -euo pipefail
set +x

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "usage: $(basename "$0") <org> <env> <proxy> <prev_revision> [failed_revision]" >&2
  exit 2
fi
ORG="$1"; ENV="$2"; PROXY="$3"; PREV_REV="${4:-}"; FAILED_REV="${5:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================================"
echo "POST-DEPLOYMENT TEST FAILED: INITIATING ROLLBACK"
echo "Org: ${ORG} | Env: ${ENV} | Proxy: ${PROXY}"
echo "============================================================"

if [[ -n "${PREV_REV}" && "${PREV_REV}" != "none" ]]; then
  echo "Rolling back ${PROXY} in ${ENV} to previous revision ${PREV_REV}..."
  bash "${SCRIPT_DIR}/deploy-revision.sh" "${ORG}" "${ENV}" "${PROXY}" "${PREV_REV}"
  echo "Waiting for revision ${PREV_REV} to reach READY state in ${ENV}..."
  bash "${SCRIPT_DIR}/wait-for-deployment.sh" "${ORG}" "${ENV}" "${PROXY}" 300 "${PREV_REV}"
  echo "SUCCESS: Rollback complete. Revision ${PREV_REV} is active and READY in ${ENV}."
  exit 0
fi

echo "Notice: No previous revision was deployed in ${ENV} prior to this run."
if [[ -z "${FAILED_REV}" || "${FAILED_REV}" == "none" ]]; then
  echo "ERROR: no previous and no failed revision given: nothing can be rolled back; check ${ENV} by hand." >&2
  exit 1
fi

TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "Undeploying failed revision ${FAILED_REV} from ${ENV}..."
if ! HTTP_CODE="$(curl -sS -o "${WORK}/resp.json" -w '%{http_code}' -X DELETE \
    -H "Authorization: Bearer ${TOKEN}" \
    "https://apigee.googleapis.com/v1/organizations/${ORG}/environments/${ENV}/apis/${PROXY}/revisions/${FAILED_REV}/deployments" \
    2>"${WORK}/curl.err")"; then
  echo "ERROR: network error undeploying revision ${FAILED_REV}: $(head -c 500 "${WORK}/curl.err")" >&2
  exit 1
fi
if [[ ! "${HTTP_CODE}" =~ ^2[0-9][0-9]$ ]]; then
  echo "ERROR: undeploying revision ${FAILED_REV} from ${ENV} failed with HTTP ${HTTP_CODE}: $(head -c 1000 "${WORK}/resp.json")" >&2
  exit 1
fi
echo "SUCCESS: Failed revision ${FAILED_REV} has been undeployed from ${ENV}."
