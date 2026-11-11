#!/usr/bin/env bash
# Asserts that a deployed proxy revision runs with the proxy runtime service account (D16, D40).
#
#   assert-proxy-runtime-sa.sh <org> <env> <proxy> <revision>
#
# GET https://apigee.googleapis.com/v1/organizations/<org>/environments/<env>/apis/<proxy>/revisions/<revision>/deployments
# and requires its serviceAccount (an email or projects/-/serviceAccounts/<email>) to name
# sa-kpi-proxy-runtime@<org>.iam.gserviceaccount.com. Without it the IntegrationEndpoint calls fail.
# Output: one OK line. Exit 0 ok; 1 API/network/parse error or a different/missing service
# account; 2 bad arguments.
# Token: gcloud auth print-access-token, else /workspace/.token. Never printed.
# Needs: curl, Python 3 (scripts/lib/python.sh).
set -euo pipefail
set +x

if [[ $# -ne 4 ]]; then
  echo "usage: $(basename "$0") <org> <env> <proxy> <revision>" >&2
  exit 2
fi
ORG="$1"; ENV_NAME="$2"; PROXY="$3"; REV="$4"
if [[ ! "${REV}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: revision must be a number (got '${REV}')." >&2
  exit 2
fi
# PY = first working Python 3: python3, python, else gcloud's bundled one (scripts/lib/python.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"
TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi
WANT="sa-kpi-proxy-runtime@${ORG}.iam.gserviceaccount.com"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
URL="https://apigee.googleapis.com/v1/organizations/${ORG}/environments/${ENV_NAME}/apis/${PROXY}/revisions/${REV}/deployments"
if ! HTTP_CODE="$(curl -sS -o "${WORK}/resp.json" -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
    "${URL}" 2>"${WORK}/curl.err")"; then
  echo "ERROR: network error reading the deployment: $(head -c 500 "${WORK}/curl.err")" >&2
  exit 1
fi
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "ERROR: reading the deployment of ${PROXY} revision ${REV} in ${ENV_NAME} failed with HTTP ${HTTP_CODE}: $(head -c 1000 "${WORK}/resp.json")" >&2
  exit 1
fi
if ! SA="$("${PY}" -c '
import json, sys
print(json.load(sys.stdin).get("serviceAccount", ""))
' < "${WORK}/resp.json")"; then
  echo "ERROR: could not parse the deployment response." >&2
  exit 1
fi
SA="$(printf '%s' "${SA}" | tr -d '\r\n')"
if [[ "${SA}" != "${WANT}" && "${SA}" != */serviceAccounts/"${WANT}" ]]; then
  echo "ERROR: ${PROXY} revision ${REV} in ${ENV_NAME} runs as '${SA:-<none>}', expected ${WANT}." >&2
  exit 1
fi
echo "OK: ${PROXY} revision ${REV} in ${ENV_NAME} runs as ${WANT}."
