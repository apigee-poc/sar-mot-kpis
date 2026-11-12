#!/usr/bin/env bash
# Deploys the debug mask of the PROD Apigee environment from the repo (AGENTS.md rule 4, D40).
# PROD ONLY: runs only inside Cloud Build with TARGET=prod (scripts/lib/prod-guard.sh). The non-prod
# scripts/deploy-debugmask.sh refuses prod and stays as it is.
#
#   deploy-debugmask-prod.sh            (no arguments)
#
# Reads src/main/apigee/environments/prod/debugmask.json, sends
#   PATCH https://apigee.googleapis.com/v1/organizations/apigee-prod-511508/environments/prod/debugmask?updateMask=variables
#   Content-Type: application/json, body {"variables":[...]} (the file's "variables" only)
# and requires HTTP 200 with every variable present in the returned mask (the PATCH appends, D58).
# Output: only the variable count. The token is never printed; an error body (no secrets) goes to
# stderr.
# Env: BUILD_ID (non-empty), TARGET=prod.
# Token: gcloud auth print-access-token, else /workspace/.token.
# Needs: node, curl (image node:22, as the non-prod script).
# Exit: 0 ok, 1 failure, 2 refused (guard / any argument), before any network call.
set -euo pipefail
set +x

readonly ORG="apigee-prod-511508"
readonly ENV_NAME="prod"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -ne 0 ]]; then
  echo "usage: $(basename "$0")   (no arguments; org ${ORG}, env ${ENV_NAME}; Cloud Build with TARGET=prod only)" >&2
  exit 2
fi
# shellcheck source=lib/prod-guard.sh
source "${SCRIPT_DIR}/lib/prod-guard.sh"
prod_guard "${ORG}"

ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MASK_DIR="${ROOT}/src/main/apigee/environments/${ENV_NAME}"
if [[ ! -f "${MASK_DIR}/debugmask.json" ]]; then
  echo "ERROR: ${MASK_DIR}/debugmask.json not found." >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required." >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Body {"variables":[...]}: a non-empty array of non-empty strings that masks the two credential
# headers (AGENTS.md rule 4), else fail. node gets relative paths (Git Bash safe).
COUNT="$(cd "${MASK_DIR}" && node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("debugmask.json", "utf8"));
const v = m.variables;
if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x.length > 0)) {
  console.error("debugmask.json: variables must be a non-empty array of strings");
  process.exit(1);
}
const lower = v.map((x) => x.toLowerCase());
for (const h of ["request.header.x-api-secret", "request.header.x-operator-id"]) {
  if (!lower.includes(h)) { console.error("debugmask.json: " + h + " is not masked"); process.exit(1); }
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
let got;
try { got = (JSON.parse(fs.readFileSync("resp.json", "utf8")).variables) || []; } catch (e) { got = []; }
const missing = want.filter((x) => !got.includes(x));
if (missing.length) { console.error("missing from the returned mask: " + missing.length + " variable(s)"); process.exit(1); }
'); then
  echo "ERROR: the ${ENV_NAME} debug mask returned by Apigee does not contain every variable." >&2
  exit 1
fi
echo "Debug mask deployed to ${ENV_NAME}: ${COUNT} variables"
