#!/usr/bin/env bash
# Checks, read-only (P8, cloudbuild-prod.yaml), that a proxy revision carries the commit stamp of
# the build that wants to promote it. Used twice: on the READY staging revision BEFORE any prod
# change (check-commit), and on the revision just imported into the prod org (copy-revision-prod,
# D67), whose description must then equal the staging one.
#
#   check-release-commit.sh <org> <proxy> <revision> <short_sha> <commit_sha>
#
#   org         the SOURCE org (staging lives in apigee-nonprod-511322), or the target org
#   revision    a number (the READY staging revision, or the imported one)
#   short_sha   the build's SHORT_SHA: 7-40 lowercase hex (empty is refused)
#   commit_sha  the build's COMMIT_SHA: 40 lowercase hex, must start with short_sha
#
# GET https://apigee.googleapis.com/v1/organizations/<org>/apis/<proxy>/revisions/<revision>
# and reads its description, which scripts/stamp-commit.sh wrote as exactly
#   <proxy> | commit <sha> | build <build_id>
# stamp-commit.sh also stamped the KVM mapIdentifiers with the same <sha> in the same run, so the
# stamp names both the code and the versioned KVM suffix the bundle reads.
# Passes only when the stamped <sha> equals short_sha exactly and commit_sha starts with it.
# Output: the description on stdout. Nothing is written.
# Exit: 0 match; 1 mismatch, empty token, network error, HTTP status other than 200, an
#       unparsable response or a description of another shape (fails CLOSED); 2 bad arguments.
# Token: gcloud auth print-access-token, else /workspace/.token. Never printed.
# Needs: curl, Python 3 (scripts/lib/python.sh); image cloud-sdk:slim.
set -euo pipefail
set +x

usage() {
  echo "usage: $(basename "$0") <org> <proxy> <revision> <short_sha> <commit_sha>" >&2
}
if [[ $# -ne 5 ]]; then
  usage
  exit 2
fi
ORG="$1"; PROXY="$2"; REV="$3"; SHA="$4"; COMMIT="$5"
if [[ ! "${ORG}" =~ ^[a-z][a-z0-9-]{1,62}$ || ! "${PROXY}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  usage
  exit 2
fi
if [[ ! "${REV}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: revision must be a number (got '${REV}')." >&2
  exit 2
fi
if [[ ! "${SHA}" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "ERROR: short_sha must be 7-40 lowercase hex characters (got '${SHA}'); run the prod pipeline from its trigger." >&2
  exit 2
fi
if [[ ! "${COMMIT}" =~ ^[0-9a-f]{40}$ || "${COMMIT}" != "${SHA}"* ]]; then
  echo "ERROR: commit_sha must be 40 lowercase hex characters starting with ${SHA} (got '${COMMIT}')." >&2
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

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
RESP="${WORK}/resp.json"
: > "${RESP}"

URL="https://apigee.googleapis.com/v1/organizations/${ORG}/apis/${PROXY}/revisions/${REV}"
if ! HTTP_CODE="$(curl -sS -o "${RESP}" -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
    "${URL}" 2>"${WORK}/curl.err")"; then
  echo "ERROR: network error reading ${PROXY} revision ${REV} in ${ORG}: $(head -c 500 "${WORK}/curl.err")" >&2
  exit 1
fi
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "ERROR: reading ${PROXY} revision ${REV} in ${ORG} failed with HTTP ${HTTP_CODE}: $(head -c 1000 "${RESP}")" >&2
  exit 1
fi
if ! DESC="$("${PY}" -c '
import json, sys
data = json.load(sys.stdin)
if not isinstance(data, dict):
    raise SystemExit("response is not a JSON object")
print(data.get("description", ""))
' < "${RESP}")"; then
  echo "ERROR: could not parse the revision response of ${PROXY} revision ${REV} (HTTP 200)." >&2
  exit 1
fi
DESC="$(printf '%s' "${DESC}" | tr -d '\r\n')"

RE="^${PROXY//./\\.} \\| commit ([0-9a-f]{7,40}) \\| build [A-Za-z0-9._-]+$"
if [[ ! "${DESC}" =~ ${RE} ]]; then
  echo "ERROR: ${PROXY} revision ${REV} in ${ORG} has no commit stamp: description is '${DESC}'." >&2
  exit 1
fi
STAMPED="${BASH_REMATCH[1]}"
if [[ "${STAMPED}" != "${SHA}" ]]; then
  echo "ERROR: ${PROXY} revision ${REV} in ${ORG} was built from commit ${STAMPED}, but this build is for ${SHA} (${COMMIT}). Promote only the commit that passed staging." >&2
  exit 1
fi
echo "${DESC}"
echo "OK: ${PROXY} revision ${REV} in ${ORG} is commit ${SHA}." >&2
