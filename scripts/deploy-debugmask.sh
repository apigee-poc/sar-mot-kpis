#!/usr/bin/env bash
# Deploys the debug mask of an Apigee environment from the repo (AGENTS.md rule 4, D40).
#
#   deploy-debugmask.sh <dev|staging>
#
#   env  dev or staging only; org apigee-nonprod-511322 fixed. prod and anything else are
#        refused before any network call (AGENTS.md rule 2).
#
# Reads src/main/apigee/environments/<env>/debugmask.json, sends
#   PATCH https://apigee.googleapis.com/v1/organizations/apigee-nonprod-511322/environments/<env>/debugmask?updateMask=variables
#   Content-Type: application/json, body {"variables":[...]} (the file's "variables" only)
# and requires HTTP 200 with every variable present in the returned mask.
# Output: only the variable count. The token and the response body are never printed (an error
# body is shown on stderr; it holds no secrets).
# Token: gcloud auth print-access-token, else /workspace/.token.
# Needs: node, curl. Exit 0 ok, 1 failure, 2 bad arguments.
set -euo pipefail
set +x

readonly ORG="apigee-nonprod-511322"

usage() {
  echo "usage: $(basename "$0") <dev|staging>   (org ${ORG})" >&2
}
if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi
ENV_NAME="$1"
case "${ENV_NAME}" in
  dev|staging) ;;
  prod)
    echo "Refusing prod: prod is changed only by cloudbuild-prod.yaml (AGENTS.md rule 2)." >&2
    exit 2
    ;;
  *)
    usage
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MASK_DIR="${ROOT}/src/main/apigee/environments/${ENV_NAME}"
if [[ ! -f "${MASK_DIR}/debugmask.json" ]]; then
  echo "ERROR: ${MASK_DIR}/debugmask.json not found." >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required." >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Body {"variables":[...]}: a non-empty array of non-empty strings, else fail. node gets relative
# paths (run from the directory) so it also works with Git Bash paths on Windows.
COUNT="$(cd "${MASK_DIR}" && node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("debugmask.json", "utf8"));
const v = m.variables;
if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x.length > 0)) {
  console.error("debugmask.json: variables must be a non-empty array of strings");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ variables: v }));
' > "${WORK}/body.json" && cd "${WORK}" && node -e '
process.stdout.write(String(JSON.parse(require("fs").readFileSync("body.json", "utf8")).variables.length));
')"

TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi

URL="https://apigee.googleapis.com/v1/organizations/${ORG}/environments/${ENV_NAME}/debugmask?updateMask=variables"
if ! HTTP_CODE="$(curl -sS -o "${WORK}/resp.json" -w '%{http_code}' -X PATCH \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    --data-binary "@${WORK}/body.json" "${URL}" 2>"${WORK}/curl.err")"; then
  echo "ERROR: network error patching the ${ENV_NAME} debug mask: $(head -c 500 "${WORK}/curl.err")" >&2
  exit 1
fi
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "ERROR: debug mask PATCH for ${ENV_NAME} failed with HTTP ${HTTP_CODE}: $(head -c 1000 "${WORK}/resp.json")" >&2
  exit 1
fi
if ! (cd "${WORK}" && node -e '
const fs = require("fs");
const want = JSON.parse(fs.readFileSync("body.json", "utf8")).variables;
const got = (JSON.parse(fs.readFileSync("resp.json", "utf8")).variables) || [];
const missing = want.filter((x) => !got.includes(x));
if (missing.length) { console.error("missing from the returned mask: " + missing.length + " variable(s)"); process.exit(1); }
'); then
  echo "ERROR: the ${ENV_NAME} debug mask returned by Apigee does not contain every variable." >&2
  exit 1
fi
echo "Debug mask deployed to ${ENV_NAME}: ${COUNT} variables"
