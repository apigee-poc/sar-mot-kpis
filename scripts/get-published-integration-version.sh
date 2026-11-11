#!/usr/bin/env bash
# Retrieves the currently published (ACTIVE) version id of an Application Integration integration.
# Usage: get-published-integration-version.sh <project> <region> <integration_name> [output_file]
# Writes the ACTIVE version id (the last path segment of the version resource name)
# or an empty string if the integration does not exist or has no ACTIVE version.
# Never fails hard: any API/parse error is reported as an empty string.
set -euo pipefail

PROJECT="$1"; REGION="$2"; INTEGRATION="$3"; OUT_FILE="${4:-}"
# First Python that actually runs: python3, then python, else gcloud's bundled one (as before).
# A bare "command -v python3" can pick the Windows Store stub, which only prints
# "Python was not found", so each candidate is probed with -c 'pass'.
PY=""
for p in python3 python; do
  if "${p}" -c 'pass' >/dev/null 2>&1; then PY="${p}"; break; fi
done
if [[ -z "${PY}" ]]; then
  PY="$(gcloud info --format='value(basic.python_location)')"
fi
TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
BASE="https://integrations.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/integrations/${INTEGRATION}"

RESP="$(curl -sS -G -H "Authorization: Bearer ${TOKEN}" \
  --data-urlencode "filter=state=ACTIVE" --data-urlencode "pageSize=50" \
  "${BASE}/versions" 2>/dev/null || echo "{}")"

VERSION="$(echo "${RESP}" | "${PY}" -c '
import json, sys
try:
    data = json.load(sys.stdin)
    versions = [v for v in data.get("integrationVersions", []) if v.get("state") == "ACTIVE" and v.get("name")]
    versions.sort(key=lambda v: v.get("updateTime", ""))
    print(versions[-1]["name"].rsplit("/", 1)[-1] if versions else "")
except Exception:
    print("")
')"

echo "Currently published version of ${INTEGRATION} in ${PROJECT}: ${VERSION:-none}" >&2

if [[ -n "${OUT_FILE}" ]]; then
  echo "${VERSION}" > "${OUT_FILE}"
else
  echo "${VERSION}"
fi
