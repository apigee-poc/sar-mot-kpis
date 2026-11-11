#!/usr/bin/env bash
# Applies (creates a new version, runs the integration tests, publishes) sar-kpi-get-<env> from
# integration/<env>, with userLabel = the short commit SHA (D20, D21, D23).
#
#   apply-integration.sh <dev|staging> [short_sha]
#
#   env        dev or staging only. Project apigee-nonprod-511322 and region us-central1 are fixed;
#              prod (and anything else) is refused before any other work (AGENTS.md rule 2).
#   short_sha  7-40 lowercase hex; default: the SHORT_SHA environment variable. In Cloud Build,
#              SHORT_SHA is a substitution, not a step env var: pass it as the argument or via
#              env: ['SHORT_SHA=$SHORT_SHA'].
#
# Steps: copy integration/<env> to a temp dir (removed by a trap), write "userLabel": <short_sha>
# into its src/sar-kpi-get-<env>.json with node (D23: --userlabel is ignored by integrationcli
# v0.86.0), then run
#   integrationcli integrations apply -f <tmp> --skip-connectors=true --wait=true \
#     --run-tests=true -p apigee-nonprod-511322 -r us-central1 -t <token>
# (no -e, D20). integrationcli comes from PATH or /workspace/bin/integrationcli
# (scripts/install-integrationcli.sh).
# Token: gcloud auth print-access-token, else /workspace/.token. Never printed; it is filtered
# out of integrationcli's output. It is visible in the process list while integrationcli runs
# (accepted POC risk, D45).
# Needs: node, integrationcli. Writes nothing in the repo.
# Exit: 0 applied/published and tests passed; integrationcli's non-zero status on failure;
#       1 setup error; 2 bad arguments.
set -euo pipefail
set +x

readonly PROJECT="apigee-nonprod-511322"
readonly REGION="us-central1"

usage() {
  echo "usage: $(basename "$0") <dev|staging> [short_sha]   (project ${PROJECT}, region ${REGION})" >&2
}
if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi
ENV_NAME="$1"
case "${ENV_NAME}" in
  dev|staging) ;;
  prod)
    echo "Refusing prod: prod is applied only by cloudbuild-prod.yaml (AGENTS.md rule 2)." >&2
    exit 2
    ;;
  *)
    usage
    exit 2
    ;;
esac
SHA="${2:-${SHORT_SHA:-}}"
if [[ ! "${SHA}" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "ERROR: short_sha (argument or SHORT_SHA) must be 7-40 lowercase hex characters." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="sar-kpi-get-${ENV_NAME}"
SRC_ROOT="${ROOT}/integration/${ENV_NAME}"
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
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required to stamp userLabel." >&2; exit 1; }

TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
APPLY_DIR="${WORK}/${ENV_NAME}"
cp -R "${SRC_ROOT}" "${APPLY_DIR}"

# Stamp userLabel (node reads the file by path relative to the temp dir: works on Git Bash too).
(cd "${APPLY_DIR}/src" && node -e '
const fs = require("fs");
const f = process.argv[1];
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.userLabel = process.argv[2];
fs.writeFileSync(f, JSON.stringify(j, null, 2));
const back = JSON.parse(fs.readFileSync(f, "utf8"));
if (back.userLabel !== process.argv[2]) { process.exit(1); }
' "${NAME}.json" "${SHA}") || { echo "ERROR: userLabel stamp failed for ${NAME}." >&2; exit 1; }
echo "Applying ${NAME} to ${PROJECT}/${REGION} with userLabel ${SHA} (from a temp copy of integration/${ENV_NAME})"

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
echo "Applied ${NAME} (userLabel ${SHA}); verify with scripts/assert-integration.sh ${ENV_NAME} ${SHA}."
