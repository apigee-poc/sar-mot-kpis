#!/usr/bin/env bash
# Applies (creates a new version, runs the integration tests, publishes) sar-kpi-get-prod from
# integration/prod, with userLabel = the short commit SHA (D20, D21, D23). PROD ONLY: runs only
# inside Cloud Build with TARGET=prod (scripts/lib/prod-guard.sh). The non-prod
# scripts/apply-integration.sh refuses prod and stays as it is.
#
#   apply-integration-prod.sh [short_sha]
#
#   short_sha  7-40 lowercase hex; default: the SHORT_SHA environment variable (in Cloud Build pass
#              it as the argument or via env: ['SHORT_SHA=$SHORT_SHA']).
# Project apigee-prod-511508 and region us-central1 are fixed.
#
# Steps: copy integration/prod to a temp dir (removed by a trap); resolve the prod Integration
# Connectors tenant project at run time (scripts/lib/connectors-tenant.sh: GET
# connectors.googleapis.com/v1/projects/<p>/locations/<r>/runtimeConfig -> serviceDirectory) and
# write it over the committed placeholder __PROD_CONNECTORS_TENANT_PROJECT__ in the copied src;
# write "userLabel": <short_sha>; refuse if any "__" placeholder remains, if the tenant is the
# non-prod tenant ef911070c468726ff-tp, or if a non-prod project/connection/trigger is present;
# then run
#   integrationcli integrations apply -f <tmp> --skip-connectors=true --wait=true \
#     --run-tests=true -p apigee-prod-511508 -r us-central1 -t <token>
# (no -e, D20). integrationcli comes from PATH or /workspace/bin/integrationcli.
# Env: BUILD_ID (non-empty), TARGET=prod; SHORT_SHA (optional, see above).
# Token: gcloud auth print-access-token, else /workspace/.token. Never printed (filtered out of
#   integrationcli's output); visible in the process list while integrationcli runs (D45).
# Needs: curl, node, integrationcli (image node:22 with the token file, as the non-prod apply).
# Writes nothing in the repo. Output on success: one line naming the applied tenant and label.
# Exit: 0 applied/published and tests passed; integrationcli's non-zero status on failure;
#       1 setup/resolution error; 2 refused (guard / bad arguments).
set -euo pipefail
set +x

readonly PROJECT="apigee-prod-511508"
readonly REGION="us-central1"
readonly NAME="sar-kpi-get-prod"
readonly PLACEHOLDER="__PROD_CONNECTORS_TENANT_PROJECT__"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: $(basename "$0") [short_sha]   (project ${PROJECT}, region ${REGION}; Cloud Build with TARGET=prod only)" >&2
}
if [[ $# -gt 1 ]]; then
  usage
  exit 2
fi
# shellcheck source=lib/prod-guard.sh
source "${SCRIPT_DIR}/lib/prod-guard.sh"
prod_guard "${PROJECT}"

SHA="${1:-${SHORT_SHA:-}}"
if [[ ! "${SHA}" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "ERROR: short_sha (argument or SHORT_SHA) must be 7-40 lowercase hex characters." >&2
  exit 2
fi

ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_ROOT="${ROOT}/integration/prod"
for p in "src/${NAME}.json" "overrides/overrides.json" "tests" "test-configs"; do
  if [[ ! -e "${SRC_ROOT}/${p}" ]]; then
    echo "ERROR: ${SRC_ROOT}/${p} is missing." >&2
    exit 1
  fi
done
# integrationcli keeps only the first *.json under src/ (D21): exactly one file must be there.
SRC_COUNT="$(find "${SRC_ROOT}/src" -type f -name '*.json' | wc -l | tr -d '[:space:]')"
if [[ "${SRC_COUNT}" != "1" ]]; then
  echo "ERROR: ${SRC_ROOT}/src must hold exactly one .json file (found ${SRC_COUNT})." >&2
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
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required to resolve and stamp the src." >&2; exit 1; }

TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi

# shellcheck source=lib/connectors-tenant.sh
source "${SCRIPT_DIR}/lib/connectors-tenant.sh"
if ! TENANT="$(resolve_connectors_tenant "${PROJECT}" "${REGION}" "${TOKEN}")"; then
  echo "ERROR: could not resolve the prod Integration Connectors tenant project; nothing was applied." >&2
  exit 1
fi
if [[ -z "${TENANT}" || "${TENANT}" == "${CONNECTORS_NONPROD_TENANT}" ]]; then
  echo "REFUSED: resolved tenant '${TENANT}' is empty or the non-prod tenant; nothing was applied." >&2
  exit 1
fi
echo "Prod Integration Connectors tenant project: ${TENANT}"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
APPLY_DIR="${WORK}/prod"
cp -R "${SRC_ROOT}" "${APPLY_DIR}"

# Resolve + stamp + check every file of the copy (node reads relative paths: Git Bash safe).
if ! (cd "${APPLY_DIR}" && node -e '
const fs = require("fs");
const path = require("path");
const [name, placeholder, tenant, sha] = process.argv.slice(1);
const srcRel = path.join("src", name + ".json");
let t = fs.readFileSync(srcRel, "utf8");
if (!t.includes(placeholder)) { console.error("REFUSED: the src does not hold " + placeholder); process.exit(1); }
t = t.split(placeholder).join(tenant);
const j = JSON.parse(t);
j.userLabel = sha;
fs.writeFileSync(srcRel, JSON.stringify(j, null, 2));
const problems = [];
const back = JSON.parse(fs.readFileSync(srcRel, "utf8"));
if (back.userLabel !== sha) problems.push("userLabel stamp failed");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const bad = [/__[A-Z0-9_]+__/, /apigee-nonprod-511322/, /ef911070c468726ff-tp/,
  /sar-kpi-db-(dev|staging)\b/, /sar-kpi-get-(dev|staging)\b/];
walk(".").forEach((f) => {
  const text = fs.readFileSync(f, "utf8");
  bad.forEach((re) => { if (re.test(text)) problems.push(f + " matches " + re); });
});
const cfg = JSON.parse(back.taskConfigs.find((x) => x.task === "GenericConnectorTask").parameters.config.value.jsonValue).connection;
const want = {
  connectionName: "projects/apigee-prod-511508/locations/us-central1/connections/sar-kpi-db-prod",
  serviceName: "projects/" + tenant + "/locations/us-central1/namespaces/connectors/services/runtime",
  connectorVersion: "projects/apigee-prod-511508/locations/global/providers/default/connectors/postgresql/versions/1"
};
Object.keys(want).forEach((k) => { if (cfg[k] !== want[k]) problems.push(k + " is " + JSON.stringify(cfg[k])); });
if (problems.length) { problems.forEach((p) => console.error("REFUSED: " + p)); process.exit(1); }
' "${NAME}" "${PLACEHOLDER}" "${TENANT}" "${SHA}"); then
  echo "ERROR: the resolved copy of integration/prod failed its checks; nothing was applied." >&2
  exit 1
fi
echo "Applying ${NAME} to ${PROJECT}/${REGION} with userLabel ${SHA}, tenant ${TENANT} (temp copy of integration/prod)"

set +e
"${CLI}" integrations apply -f "${APPLY_DIR}" \
  --skip-connectors=true --wait=true --run-tests=true \
  -p "${PROJECT}" -r "${REGION}" -t "${TOKEN}" 2>&1 | sed "s#${TOKEN}#***TOKEN***#g"
RC="${PIPESTATUS[0]}"
set -e
if [[ "${RC}" != "0" ]]; then
  echo "ERROR: integrationcli integrations apply failed for ${NAME} (exit ${RC})." >&2
  exit "${RC}"
fi
echo "Applied ${NAME} (userLabel ${SHA}, tenant ${TENANT}); verify with scripts/assert-integration-prod.sh ${SHA}."
