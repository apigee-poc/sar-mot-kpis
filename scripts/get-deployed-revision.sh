#!/usr/bin/env bash
# Retrieves the revision of an API proxy currently deployed in an environment.
#
#   get-deployed-revision.sh <org> <env> <proxy> [output_file]
#
# Output: the deployed revision number (e.g. "12"; the highest one if several are listed) on
# stdout, or written to [output_file] when given (stdout then stays empty). A status line goes to
# stderr.
# Exit status (P7 final review I-4: fails CLOSED, like get-published-integration-version.sh):
#   0  HTTP 200 with deployments            -> prints the revision
#   0  HTTP 200 without deployments, or 404 -> prints an empty string ("none")
#   1  anything else: empty token, network error, HTTP 401/403/5xx or any other status, a 200
#      body that is not valid JSON, or no working Python 3. Nothing is written to [output_file].
# A transient failure must never look like "no previous revision": rollback.sh would then
# undeploy instead of restoring.
# Token: gcloud auth print-access-token, else /workspace/.token (Cloud Build). Never printed.
set -euo pipefail
set +x

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $(basename "$0") <org> <env> <proxy> [output_file]" >&2
  exit 2
fi
ORG="$1"; ENV="$2"; PROXY="$3"; OUT_FILE="${4:-}"
# PY = first working Python 3: python3, python, else gcloud's bundled one (scripts/lib/python.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"
TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi
BASE="https://apigee.googleapis.com/v1/organizations/${ORG}/environments/${ENV}/apis/${PROXY}"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
RESP="${WORK}/resp.json"
: > "${RESP}"

# curl -sS without --fail: exits 0 on any HTTP status (checked below) and non-zero on a network error.
if ! HTTP_CODE="$(curl -sS -o "${RESP}" -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
    "${BASE}/deployments" 2>"${WORK}/curl.err")"; then
  echo "ERROR: network error reading the deployments of ${PROXY} in ${ENV}: $(head -c 500 "${WORK}/curl.err")" >&2
  exit 1
fi

case "${HTTP_CODE}" in
  200)
    if ! REV="$("${PY}" -c '
import json, sys
data = json.load(sys.stdin)
if not isinstance(data, dict):
    raise SystemExit("response is not a JSON object")
revs = [int(x["revision"]) for x in data.get("deployments", []) if "revision" in x]
print(max(revs) if revs else "")
' < "${RESP}")"; then
      echo "ERROR: could not parse the deployments response of ${PROXY} in ${ENV} (HTTP 200)." >&2
      exit 1
    fi
    ;;
  404)
    REV=""
    ;;
  *)
    echo "ERROR: reading the deployments of ${PROXY} in ${ENV} failed with HTTP ${HTTP_CODE}: $(head -c 1000 "${RESP}")" >&2
    exit 1
    ;;
esac
REV="$(printf '%s' "${REV}" | tr -d '\r\n')"

echo "Currently active revision in ${ENV}: ${REV:-none}" >&2

if [[ -n "${OUT_FILE}" ]]; then
  echo "${REV}" > "${OUT_FILE}"
else
  echo "${REV}"
fi
