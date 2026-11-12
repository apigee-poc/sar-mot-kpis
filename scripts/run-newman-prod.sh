#!/usr/bin/env bash
# Read-only prod smoke test (P8): runs ONLY the "Happy paths" folder of the Newman collection
# against prod (https://prod.35.201.86.122.nip.io). PROD ONLY: runs only inside Cloud Build with
# TARGET=prod (scripts/lib/prod-guard.sh); tests/run-newman.sh refuses prod and stays as it is.
#
#   run-newman-prod.sh            (no arguments: nothing can be added, D47 allowlist philosophy)
#
# The "Happy paths" requests are GETs that assert the exact seed values (D47), so kpis_prod must
# hold the same seed as dev/staging (db/load.sh prod). Error rows, fault injection and the
# 403 product test are NOT run in prod (no "other" app exists there).
# Credentials: the smoke app mot-smoke-app (infra/06), read from prod Secret Manager
#   sar-mot-smoke-app-api-key, sar-mot-smoke-app-api-secret
# with gcloud when it is on PATH, else the Secret Manager REST API with /workspace/.token (node
# base64-decodes the value, D49). They only reach shell variables and newman's --env-var; they
# are never echoed or written to a file (visible in the process list while newman runs, D45).
# Environment file: tests/environments/prod.postman_environment.json; its baseUrl must be exactly
# https://prod.35.201.86.122.nip.io (checked before any secret is read).
# Report: reports/newman-prod-smoke.xml (junit) plus the CLI reporter.
# Env: BUILD_ID (non-empty), TARGET=prod.
# Needs: node, npx with the repo's node_modules (npm ci), curl when gcloud is absent (node:22).
# Exit: newman's status (0 all passed); 1 setup/secret error; 2 refused (guard / any argument),
#       before any network call.
set -euo pipefail
set +x

readonly PROJECT="apigee-prod-511508"
readonly BASE_URL="https://prod.35.201.86.122.nip.io"
readonly FOLDER="Happy paths"
readonly SECRET_KEY="sar-mot-smoke-app-api-key"
readonly SECRET_SECRET="sar-mot-smoke-app-api-secret"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -ne 0 ]]; then
  # Not echoed: a stray value could be a credential.
  echo "usage: $(basename "$0")   (no arguments allowed; runs the \"${FOLDER}\" folder against ${BASE_URL})" >&2
  exit 2
fi
# shellcheck source=lib/prod-guard.sh
source "${SCRIPT_DIR}/lib/prod-guard.sh"
prod_guard "${PROJECT}"

ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"
COLLECTION="tests/sar-mot-kpis.postman_collection.json"
ENV_FILE="tests/environments/prod.postman_environment.json"
REPORT="reports/newman-prod-smoke.xml"
for f in "${COLLECTION}" "${ENV_FILE}"; do
  [[ -f "${f}" ]] || { echo "ERROR: ${f} not found." >&2; exit 1; }
done
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required." >&2; exit 1; }

# The env file must point at the prod host and the collection must have the folder.
if ! node -e '
const fs = require("fs");
const env = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const base = (env.values || []).find((v) => v.key === "baseUrl");
if (!base || base.value !== process.argv[3]) {
  console.error("baseUrl in " + process.argv[1] + " is not " + process.argv[3]);
  process.exit(1);
}
const col = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!(col.item || []).some((i) => i.name === process.argv[4])) {
  console.error("folder \"" + process.argv[4] + "\" not found in the collection");
  process.exit(1);
}
' "${ENV_FILE}" "${COLLECTION}" "${BASE_URL}" "${FOLDER}"; then
  echo "ERROR: prod smoke configuration check failed." >&2
  exit 1
fi

read_secret() {
  if command -v gcloud >/dev/null 2>&1; then
    gcloud secrets versions access latest --secret="$1" --project="${PROJECT}" --quiet
    return
  fi
  local token
  token="$(tr -d '\r\n[:space:]' < /workspace/.token 2>/dev/null || true)"
  if [[ -z "${token}" ]]; then
    echo "ERROR: no gcloud and no /workspace/.token: cannot read secret $1" >&2
    return 1
  fi
  curl -sS --fail -H "Authorization: Bearer ${token}" \
    "https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/$1/versions/latest:access" \
    | node -e '
let s = "";
process.stdin.on("data", (c) => { s += c; });
process.stdin.on("end", () => {
  let d;
  try { d = JSON.parse(s).payload.data; } catch (e) { d = undefined; }
  if (typeof d !== "string" || d === "") {
    process.stderr.write("ERROR: unexpected Secret Manager response\n");
    process.exit(1);
  }
  process.stdout.write(Buffer.from(d, "base64").toString("utf8"));
});'
}

# Plain assignments so a failing read stops the script (set -e); an empty value fails closed.
API_KEY="$(read_secret "${SECRET_KEY}")"
API_SECRET="$(read_secret "${SECRET_SECRET}")"
if [[ -z "${API_KEY}" || -z "${API_SECRET}" ]]; then
  echo "ERROR: a smoke-app credential is empty (${SECRET_KEY} / ${SECRET_SECRET})." >&2
  exit 1
fi

mkdir -p reports
npx --no-install newman run "${COLLECTION}" \
  -e "${ENV_FILE}" \
  --folder "${FOLDER}" \
  --env-var "apiKey=${API_KEY}" \
  --env-var "apiSecret=${API_SECRET}" \
  --reporters cli,junit \
  --reporter-junit-export "${REPORT}"
