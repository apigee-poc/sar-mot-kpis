#!/usr/bin/env bash
# Creates the PROD Integration Connectors PostgreSQL connection sar-kpi-db-prod (P8). PROD ONLY:
# runs only inside Cloud Build with TARGET=prod (scripts/lib/prod-guard.sh); the non-prod
# connections were created once by hand in P3.
#
#   create-connection.sh prod
#
# Project apigee-prod-511508 and region us-central1 are fixed. Any other argument is refused
# before any network call.
# Steps:
#   1. GET the connection. ACTIVE -> nothing to do (exit 0). Exists in another state -> exit 1
#      (never re-created or changed here; fix by hand). 404 -> create. Anything else -> exit 1.
#   2. Endpoint attachment sar-kpi-sql-prod-ea (infra/04): must be ACCEPTED with an IPv4
#      endpointIp (GET ...endpointAttachments/<name>?view=ENDPOINT_ATTACHMENT_VIEW_FULL: state is
#      returned in the FULL view only, per the Connectors v1 REST reference). That IP is the
#      PostgreSQL host (D19 records the non-prod 10.128.0.2 but not how it was read; endpointIp
#      is the field the reference documents as the PSC connection endpoint IP).
#   3. DB password: the newest ENABLED version NUMBER of secret sar-kpi-db-reader-password
#      (Secret Manager metadata GET .../versions/latest, no payload is read). The connection
#      references it by version; the password itself never passes through this script.
#   4. Copy integration/connectors/sar-kpi-db-prod.json to a temp dir, replace
#      __PROD_ENDPOINT_ATTACHMENT_IP__ and __PROD_DB_SECRET_VERSION__, refuse if any "__"
#      placeholder remains, check database_name kpis_prod and serviceAccount sa-kpi-connector.
#   5. integrationcli connectors create -n sar-kpi-db-prod -f <tmp> -p <project> -r <region>
#      -t <token> --wait=true (no --sa / -g: the serviceAccount comes from the file; integrationcli
#      keeps a serviceAccount given in the file), then poll the connection until ACTIVE (~10 min).
# Env: BUILD_ID (non-empty), TARGET=prod.
# Token: gcloud auth print-access-token, else /workspace/.token. Never printed (filtered out of
#   integrationcli's output); visible in the process list while integrationcli runs (D45).
# Needs: curl, node, integrationcli (PATH or /workspace/bin, scripts/install-integrationcli.sh);
#   image node:22 (with the token file) or any image with those three.
# Exit: 0 ACTIVE (created or already there); 1 failure; 2 refused (guard / bad arguments).
set -euo pipefail
set +x

readonly PROJECT="apigee-prod-511508"
readonly REGION="us-central1"
readonly CONNECTION="sar-kpi-db-prod"
readonly ATTACHMENT="sar-kpi-sql-prod-ea"
readonly DB_SECRET="sar-kpi-db-reader-password"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: $(basename "$0") prod   (project ${PROJECT}, region ${REGION}; Cloud Build with TARGET=prod only)" >&2
}
if [[ $# -ne 1 || "$1" != "prod" ]]; then
  usage
  exit 2
fi
# shellcheck source=lib/prod-guard.sh
source "${SCRIPT_DIR}/lib/prod-guard.sh"
prod_guard "${PROJECT}"

ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE="${ROOT}/integration/connectors/${CONNECTION}.json"
if [[ ! -f "${TEMPLATE}" ]]; then
  echo "ERROR: ${TEMPLATE} not found." >&2
  exit 1
fi
if command -v integrationcli >/dev/null 2>&1; then
  CLI="integrationcli"
elif [[ -x /workspace/bin/integrationcli ]]; then
  CLI="/workspace/bin/integrationcli"
else
  echo "ERROR: integrationcli not found on PATH or at /workspace/bin/integrationcli (run scripts/install-integrationcli.sh)." >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required." >&2; exit 1; }

TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# get <url> <file>: sets CODE; exits 1 on a network error.
CODE=""
get() {
  : > "$2"
  if ! CODE="$(curl -sS -o "$2" -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" "$1" 2>"${WORK}/curl.err")"; then
    echo "ERROR: network error on GET $1: $(head -c 300 "${WORK}/curl.err")" >&2
    exit 1
  fi
}
# jfield <file> <dotted.path>: prints the string/number at the path, or nothing. Exit 1 if the
# file is not JSON. node reads a path relative to WORK (Git Bash safe).
jfield() {
  (cd "${WORK}" && node -e '
const fs = require("fs");
let v;
try { v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(1); }
for (const k of process.argv[2].split(".")) { v = (v && typeof v === "object") ? v[k] : undefined; }
if (typeof v === "string" || typeof v === "number") process.stdout.write(String(v));
' "$(basename "$1")" "$2")
}

CONN_URL="https://connectors.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/connections/${CONNECTION}"

# 1. Existing connection?
get "${CONN_URL}" "${WORK}/conn.json"
case "${CODE}" in
  200)
    STATE="$(jfield "${WORK}/conn.json" status.state)" || { echo "ERROR: connection response is not JSON." >&2; exit 1; }
    if [[ "${STATE}" == "ACTIVE" ]]; then
      echo "Connection ${CONNECTION} already exists and is ACTIVE; nothing to do."
      exit 0
    fi
    echo "ERROR: connection ${CONNECTION} exists in state '${STATE:-UNKNOWN}' (not ACTIVE). It is not re-created here; inspect it in the console." >&2
    exit 1
    ;;
  404) echo "Connection ${CONNECTION} does not exist yet; creating it." ;;
  *)
    echo "ERROR: GET connection ${CONNECTION} failed with HTTP ${CODE}: $(head -c 500 "${WORK}/conn.json")" >&2
    exit 1
    ;;
esac

# 2. Endpoint attachment IP.
get "https://connectors.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/endpointAttachments/${ATTACHMENT}?view=ENDPOINT_ATTACHMENT_VIEW_FULL" "${WORK}/ea.json"
if [[ "${CODE}" != "200" ]]; then
  echo "ERROR: GET endpoint attachment ${ATTACHMENT} failed with HTTP ${CODE} (run infra/04 first): $(head -c 500 "${WORK}/ea.json")" >&2
  exit 1
fi
EA_STATE="$(jfield "${WORK}/ea.json" state)" || { echo "ERROR: endpoint attachment response is not JSON." >&2; exit 1; }
EA_IP="$(jfield "${WORK}/ea.json" endpointIp)" || true
if [[ "${EA_STATE}" != "ACCEPTED" ]]; then
  echo "ERROR: endpoint attachment ${ATTACHMENT} is '${EA_STATE:-UNKNOWN}', not ACCEPTED." >&2
  exit 1
fi
if [[ ! "${EA_IP}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "ERROR: endpoint attachment ${ATTACHMENT} has no IPv4 endpointIp (got '${EA_IP}')." >&2
  exit 1
fi
echo "Endpoint attachment ${ATTACHMENT}: ACCEPTED, host ${EA_IP}:5432"

# 3. DB password secret version (metadata only).
get "https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${DB_SECRET}/versions/latest" "${WORK}/sv.json"
if [[ "${CODE}" != "200" ]]; then
  echo "ERROR: reading the metadata of ${DB_SECRET}/versions/latest failed with HTTP ${CODE} (run infra/03 first)." >&2
  exit 1
fi
SV_NAME="$(jfield "${WORK}/sv.json" name)" || { echo "ERROR: secret version response is not JSON." >&2; exit 1; }
SV_STATE="$(jfield "${WORK}/sv.json" state)" || true
SV_NUM="${SV_NAME##*/}"
if [[ ! "${SV_NUM}" =~ ^[0-9]+$ || "${SV_STATE}" != "ENABLED" ]]; then
  echo "ERROR: ${DB_SECRET} has no ENABLED latest version (name '${SV_NAME}', state '${SV_STATE}')." >&2
  exit 1
fi
echo "DB password reference: ${DB_SECRET} version ${SV_NUM}"

# 4. Resolved temp copy of the template.
cp "${TEMPLATE}" "${WORK}/connection.json"
if ! (cd "${WORK}" && node -e '
const fs = require("fs");
const f = "connection.json";
let t = fs.readFileSync(f, "utf8");
t = t.split("__PROD_ENDPOINT_ATTACHMENT_IP__").join(process.argv[1])
     .split("__PROD_DB_SECRET_VERSION__").join(process.argv[2]);
const problems = [];
if (t.includes("__")) problems.push("an unresolved __ placeholder remains");
let j;
try { j = JSON.parse(t); } catch (e) { problems.push("not valid JSON"); }
if (j) {
  const db = (j.configVariables || []).find((c) => c.key === "database_name");
  if (!db || db.stringValue !== "kpis_prod") problems.push("database_name is not kpis_prod");
  if (j.serviceAccount !== "sa-kpi-connector@apigee-prod-511508.iam.gserviceaccount.com") problems.push("serviceAccount is not sa-kpi-connector");
  const host = (((j.destinationConfigs || [])[0] || {}).destinations || [])[0] || {};
  if (host.host !== process.argv[1] || host.port !== 5432) problems.push("host is not the endpoint attachment IP:5432");
  const sv = (((j.authConfig || {}).userPassword || {}).password || {}).secretVersion;
  if (sv !== "projects/apigee-prod-511508/secrets/sar-kpi-db-reader-password/versions/" + process.argv[2]) problems.push("secretVersion mismatch");
  if (/nonprod|ef911070c468726ff-tp|kpis_dev|kpis_staging/.test(t)) problems.push("a non-prod value is present");
}
if (problems.length) { problems.forEach((p) => console.error("REFUSED: " + p)); process.exit(1); }
fs.writeFileSync(f, t);
' "${EA_IP}" "${SV_NUM}"); then
  echo "ERROR: the resolved ${CONNECTION}.json failed its checks; nothing was created." >&2
  exit 1
fi

# 5. Create and wait.
echo "Creating connection ${CONNECTION} in ${PROJECT}/${REGION} (integrationcli connectors create --wait=true)..."
set +e
"${CLI}" connectors create -n "${CONNECTION}" -f "${WORK}/connection.json" \
  -p "${PROJECT}" -r "${REGION}" -t "${TOKEN}" --wait=true 2>&1 | sed "s#${TOKEN}#***TOKEN***#g"
RC="${PIPESTATUS[0]}"
set -e
if [[ "${RC}" != "0" ]]; then
  echo "ERROR: integrationcli connectors create failed for ${CONNECTION} (exit ${RC})." >&2
  exit "${RC}"
fi

STATE=""
for _ in $(seq 1 60); do
  get "${CONN_URL}" "${WORK}/conn.json"
  if [[ "${CODE}" == "200" ]]; then
    STATE="$(jfield "${WORK}/conn.json" status.state || true)"
    [[ "${STATE}" == "ACTIVE" ]] && break
    if [[ "${STATE}" == "ERROR" ]]; then
      echo "ERROR: connection ${CONNECTION} is in state ERROR: $(jfield "${WORK}/conn.json" status.description || true)" >&2
      exit 1
    fi
  fi
  sleep 10
done
if [[ "${STATE}" != "ACTIVE" ]]; then
  echo "ERROR: connection ${CONNECTION} did not become ACTIVE (last state '${STATE:-UNKNOWN}')." >&2
  exit 1
fi
echo "Connection ${CONNECTION} is ACTIVE (host ${EA_IP}:5432, database kpis_prod, ${DB_SECRET} v${SV_NUM})."
