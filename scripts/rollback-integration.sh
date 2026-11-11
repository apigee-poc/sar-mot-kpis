#!/usr/bin/env bash
# Rolls back an Application Integration integration after a post-deployment test failure.
# Usage: rollback-integration.sh <project> <region> <integration_name> <prev_version> [failed_version]
#
# If prev_version is present: a superseded version (moved to SNAPSHOT when a newer version was
#   published, D29) cannot be re-published by id, so the previous version's content is
#   copied into a NEW DRAFT version (versions.create) which is then published and verified ACTIVE.
#   If that restore fails, failed_version (if given) is unpublished as a safety net and the
#   script exits non-zero.
# If prev_version is empty/none: unpublishes failed_version so broken code is not live and
#   verifies it is no longer ACTIVE.
set -euo pipefail

PROJECT="$1"; REGION="$2"; INTEGRATION="$3"; PREV_VER="${4:-}"; FAILED_VER="${5:-}"
# PY = first working Python 3: python3, python, else gcloud's bundled one (scripts/lib/python.sh).
source "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"
TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
BASE="https://integrations.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/integrations/${INTEGRATION}/versions"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
RESP="${WORK}/resp.json"
EMPTY_BODY="${WORK}/empty.json"
printf '{}' > "${EMPTY_BODY}"

# api <METHOD> <URL> [json_body_file]
# Writes the response body to ${RESP}. Returns 0 on HTTP 2xx; otherwise prints the API error
# body to stderr (never the request body or token) and returns 1.
api() {
  local method="$1" url="$2" data="${3:-}" code
  local args=(-sS -o "${RESP}" -w '%{http_code}' -X "${method}" -H "Authorization: Bearer ${TOKEN}")
  if [[ -n "${data}" ]]; then
    args+=(-H "Content-Type: application/json" --data-binary "@${data}")
  fi
  : > "${RESP}"
  code="$(curl "${args[@]}" "${url}" 2>/dev/null || echo "000")"
  if [[ "${code}" =~ ^2[0-9][0-9]$ ]]; then
    return 0
  fi
  echo "API ${method} failed with HTTP ${code}: $(head -c 2000 "${RESP}" 2>/dev/null || true)" >&2
  return 1
}

# json_get <file> <top-level key> : prints the string value or empty.
json_get() {
  "${PY}" -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        print(json.load(f).get(sys.argv[2], ""))
except Exception:
    print("")
' "$1" "$2"
}

# version_state <version_id> : prints the version state (empty if it cannot be read).
version_state() {
  if api GET "${BASE}/$1"; then
    json_get "${RESP}" state
  else
    echo ""
  fi
}

# unpublish_verified <version_id> : unpublishes and succeeds only if state is verified not ACTIVE.
unpublish_verified() {
  local ver="$1" state
  # Unpublish errors (e.g. "not ACTIVE") are tolerated here; the state check below decides.
  api POST "${BASE}/${ver}:unpublish" "${EMPTY_BODY}" || true
  state="$(version_state "${ver}")"
  if [[ -n "${state}" && "${state}" != "ACTIVE" ]]; then
    echo "Version ${ver} is no longer ACTIVE (state: ${state})."
    return 0
  fi
  echo "ERROR: Could not verify version ${ver} is unpublished (state: ${state:-unknown})." >&2
  return 1
}

# restore_previous <version_id> : copies the version into a new DRAFT, publishes it, verifies ACTIVE.
restore_previous() {
  local prev="$1" new_name new_id state deadline
  echo "Fetching content of previous version ${prev}..."
  api GET "${BASE}/${prev}" || return 1
  # Drop output-only / server-assigned fields so the content can be created as a new draft.
  "${PY}" -c '
import json, sys
with open(sys.argv[1]) as f:
    v = json.load(f)
for k in ("name", "state", "snapshotNumber", "createTime", "updateTime", "lockHolder",
          "lastModifierEmail", "origin"):
    v.pop(k, None)
with open(sys.argv[2], "w") as f:
    json.dump(v, f)
' "${RESP}" "${WORK}/body.json" || { echo "Could not prepare previous version content." >&2; return 1; }

  echo "Creating a new DRAFT version from version ${prev}..."
  api POST "${BASE}" "${WORK}/body.json" || return 1
  new_name="$(json_get "${RESP}" name)"
  new_id="${new_name##*/}"
  if [[ -z "${new_id}" ]]; then
    echo "New draft version id missing from create response." >&2
    return 1
  fi
  echo "Publishing restored version ${new_id}..."
  api POST "${BASE}/${new_id}:publish" "${EMPTY_BODY}" || return 1

  echo "Waiting for restored version ${new_id} to reach ACTIVE state..."
  deadline=$((SECONDS + 300))
  while true; do
    state="$(version_state "${new_id}")"
    if [[ "${state}" == "ACTIVE" ]]; then
      break
    fi
    if (( SECONDS >= deadline )); then
      echo "Restored version ${new_id} did not reach ACTIVE within 300s (last state: ${state:-unknown})." >&2
      return 1
    fi
    sleep 5
  done
  echo "SUCCESS: Rollback complete. Version ${new_id} (content of ${prev}) is ACTIVE for ${INTEGRATION}."
}

echo "============================================================"
echo "POST-DEPLOYMENT TEST FAILED: INITIATING INTEGRATION ROLLBACK"
echo "Project: ${PROJECT} | Region: ${REGION} | Integration: ${INTEGRATION}"
echo "============================================================"

if [[ -n "${PREV_VER}" && "${PREV_VER}" != "none" ]]; then
  echo "Rolling back ${INTEGRATION} to the content of previous version ${PREV_VER}..."
  if ! restore_previous "${PREV_VER}"; then
    echo "ERROR: Restoring previous version ${PREV_VER} of ${INTEGRATION} failed." >&2
    if [[ -n "${FAILED_VER}" && "${FAILED_VER}" != "none" ]]; then
      echo "Fallback: unpublishing failed version ${FAILED_VER} so broken code is not live..." >&2
      unpublish_verified "${FAILED_VER}" || true
    fi
    echo "ERROR: Rollback of ${INTEGRATION} did not complete; manual intervention required." >&2
    exit 1
  fi
else
  echo "Notice: No previous version was published for ${INTEGRATION} prior to this run."
  if [[ -n "${FAILED_VER}" && "${FAILED_VER}" != "none" ]]; then
    echo "Unpublishing failed version ${FAILED_VER} of ${INTEGRATION}..."
    if unpublish_verified "${FAILED_VER}"; then
      echo "SUCCESS: Failed version ${FAILED_VER} has been unpublished from ${INTEGRATION}."
    else
      echo "ERROR: Failed version ${FAILED_VER} may still be live on ${INTEGRATION}." >&2
      exit 1
    fi
  fi
fi
