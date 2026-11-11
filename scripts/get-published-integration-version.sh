#!/usr/bin/env bash
# Retrieves the currently published (ACTIVE) version id of an Application Integration integration.
#
#   get-published-integration-version.sh <project> <region> <integration_name> [output_file]
#
# Output: the ACTIVE version id (last path segment of the version resource name) on stdout, or
# written to [output_file] when given (stdout then stays empty). A status line goes to stderr.
#
# Exit status (P4 carry-over I-3 / M-4: this script fails CLOSED):
#   0  HTTP 200 with an ACTIVE version            -> prints the id
#   0  HTTP 200 without an ACTIVE version, or 404 -> prints an empty string ("none")
#   1  anything else: empty token, network error, HTTP 401/403/5xx or any other status, a 200
#      body that is not valid JSON, or no working Python 3. Nothing is written to [output_file].
# A transient failure must never look like "no previous version": rollback-integration.sh would
# then unpublish instead of restoring.
#
# Token: gcloud auth print-access-token, else /workspace/.token (Cloud Build). Never printed.
set -euo pipefail
set +x

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "usage: $(basename "$0") <project> <region> <integration_name> [output_file]" >&2
  exit 2
fi
PROJECT="$1"; REGION="$2"; INTEGRATION="$3"; OUT_FILE="${4:-}"
# PY = first working Python 3: python3, python, else gcloud's bundled one (scripts/lib/python.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"
TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi
BASE="https://integrations.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/integrations/${INTEGRATION}"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
RESP="${WORK}/resp.json"
: > "${RESP}"

# curl -sS without --fail: exits 0 on any HTTP status (checked below) and non-zero on a network error.
if ! HTTP_CODE="$(curl -sS -G -o "${RESP}" -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
    --data-urlencode "filter=state=ACTIVE" --data-urlencode "pageSize=50" \
    "${BASE}/versions" 2>"${WORK}/curl.err")"; then
  echo "ERROR: network error listing versions of ${INTEGRATION}: $(head -c 500 "${WORK}/curl.err")" >&2
  exit 1
fi

case "${HTTP_CODE}" in
  200)
    if ! VERSION="$("${PY}" -c '
import json, sys
data = json.load(sys.stdin)
if not isinstance(data, dict):
    raise SystemExit("response is not a JSON object")
versions = [v for v in data.get("integrationVersions", []) if v.get("state") == "ACTIVE" and v.get("name")]
versions.sort(key=lambda v: v.get("updateTime", ""))
print(versions[-1]["name"].rsplit("/", 1)[-1] if versions else "")
' < "${RESP}")"; then
      echo "ERROR: could not parse the versions response of ${INTEGRATION} (HTTP 200)." >&2
      exit 1
    fi
    ;;
  404)
    VERSION=""
    ;;
  *)
    echo "ERROR: listing versions of ${INTEGRATION} failed with HTTP ${HTTP_CODE}: $(head -c 1000 "${RESP}")" >&2
    exit 1
    ;;
esac
VERSION="$(printf '%s' "${VERSION}" | tr -d '\r\n')"

echo "Currently published version of ${INTEGRATION} in ${PROJECT}: ${VERSION:-none}" >&2

if [[ -n "${OUT_FILE}" ]]; then
  echo "${VERSION}" > "${OUT_FILE}"
else
  echo "${VERSION}"
fi
