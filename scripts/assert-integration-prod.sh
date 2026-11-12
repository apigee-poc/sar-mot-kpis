#!/usr/bin/env bash
# Post-apply assertion on the ACTIVE (published) version of sar-kpi-get-prod (P8). PROD ONLY:
# runs only inside Cloud Build with TARGET=prod (scripts/lib/prod-guard.sh). Stricter than the
# non-prod scripts/assert-integration.sh, which refuses prod and stays as it is.
#
#   assert-integration-prod.sh <short_sha> [output_file]
#
#   short_sha  7-40 lowercase hex: the expected userLabel.
# Project apigee-prod-511508 and region us-central1 are fixed.
#
# Gets the ACTIVE version id with scripts/get-published-integration-version.sh (fails closed),
# fetches that version and asserts:
#   (a) userLabel == short_sha
#   (b) exactly one GenericConnectorTask, taskId 2, whose config connection has
#       connectionName == projects/apigee-prod-511508/locations/us-central1/connections/sar-kpi-db-prod,
#       connectorVersion in the prod project, and a serviceName
#       projects/<tenant>/locations/us-central1/namespaces/connectors/services/runtime
#   (c) at least one API trigger, and every API trigger has triggerId api_trigger/sar-kpi-get-prod
#   (d) none of these appear anywhere in the version: apigee-nonprod-511322, the non-prod tenant
#       ef911070c468726ff-tp, an unresolved __PROD_ placeholder, sar-kpi-db-dev/-staging,
#       sar-kpi-get-dev/-staging
# Output on success: the version id on stdout (and in [output_file] when given).
# Env: BUILD_ID (non-empty), TARGET=prod.
# Token: gcloud auth print-access-token, else /workspace/.token. Never printed.
# Needs: curl, Python 3 (scripts/lib/python.sh); image cloud-sdk:slim.
# Exit: 0 all assertions hold; 1 no ACTIVE version, API/parse error, or a failed assertion (the
#       message names it); 2 refused (guard / bad arguments), before any network call.
set -euo pipefail
set +x

readonly PROJECT="apigee-prod-511508"
readonly REGION="us-central1"
readonly NAME="sar-kpi-get-prod"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: $(basename "$0") <short_sha> [output_file]   (project ${PROJECT}; Cloud Build with TARGET=prod only)" >&2
}
if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi
# shellcheck source=lib/prod-guard.sh
source "${SCRIPT_DIR}/lib/prod-guard.sh"
prod_guard "${PROJECT}"

SHA="$1"; OUT_FILE="${2:-}"
if [[ ! "${SHA}" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "ERROR: short_sha must be 7-40 lowercase hex characters." >&2
  exit 2
fi

# PY = first working Python 3 (scripts/lib/python.sh).
# shellcheck source=lib/python.sh
source "${SCRIPT_DIR}/lib/python.sh"

VERSION="$(bash "${SCRIPT_DIR}/get-published-integration-version.sh" "${PROJECT}" "${REGION}" "${NAME}")"
VERSION="$(printf '%s' "${VERSION}" | tr -d '\r\n[:space:]')"
if [[ -z "${VERSION}" ]]; then
  echo "ASSERTION FAILED: ${NAME} has no ACTIVE version." >&2
  exit 1
fi

TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
RESP="${WORK}/version.json"
: > "${RESP}"
URL="https://integrations.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/integrations/${NAME}/versions/${VERSION}"
if ! HTTP_CODE="$(curl -sS -o "${RESP}" -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
    "${URL}" 2>"${WORK}/curl.err")"; then
  echo "ERROR: network error fetching ${NAME} version ${VERSION}: $(head -c 500 "${WORK}/curl.err")" >&2
  exit 1
fi
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "ERROR: fetching ${NAME} version ${VERSION} failed with HTTP ${HTTP_CODE}: $(head -c 1000 "${RESP}")" >&2
  exit 1
fi

# Python prints nothing on success; on failure one "ASSERTION FAILED: ..." line per problem, exit 1.
"${PY}" -c '
import json, re, sys
sha = sys.argv[1]
problems = []
try:
    v = json.load(sys.stdin)
except Exception as e:
    print("ASSERTION FAILED: version response is not JSON (%s)" % e.__class__.__name__)
    sys.exit(1)
if not isinstance(v, dict):
    print("ASSERTION FAILED: version response is not a JSON object")
    sys.exit(1)
text = json.dumps(v)

label = v.get("userLabel", "")
if label != sha:
    problems.append("userLabel is %r, expected %r" % (label, sha))

want_conn = "projects/apigee-prod-511508/locations/us-central1/connections/sar-kpi-db-prod"
want_ver = "projects/apigee-prod-511508/locations/global/providers/default/connectors/postgresql/versions/1"
svc_re = re.compile(r"^projects/[a-z0-9][a-z0-9-]{3,61}[a-z0-9]/locations/us-central1/namespaces/connectors/services/runtime$")
connectors = [t for t in v.get("taskConfigs", []) if t.get("task") == "GenericConnectorTask"]
if len(connectors) != 1:
    problems.append("expected exactly 1 GenericConnectorTask, found %d" % len(connectors))
else:
    t = connectors[0]
    if t.get("taskId") != "2":
        problems.append("the GenericConnectorTask is task %r, expected 2" % t.get("taskId"))
    conn = {}
    try:
        conn = json.loads(t["parameters"]["config"]["value"]["jsonValue"])["connection"]
    except Exception:
        problems.append("task %s: parameters.config.value.jsonValue has no connection" % t.get("taskId"))
    if conn:
        if conn.get("connectionName") != want_conn:
            problems.append("connectionName is %r, expected %r" % (conn.get("connectionName"), want_conn))
        if conn.get("connectorVersion") != want_ver:
            problems.append("connectorVersion is %r, expected %r" % (conn.get("connectorVersion"), want_ver))
        if not svc_re.match(conn.get("serviceName") or ""):
            problems.append("serviceName %r is not a Connectors runtime service" % conn.get("serviceName"))

want_trig = "api_trigger/sar-kpi-get-prod"
api_triggers = [tc for tc in v.get("triggerConfigs", []) if tc.get("triggerType") == "API"]
if not api_triggers:
    problems.append("no API trigger found")
for tc in api_triggers:
    if tc.get("triggerId") != want_trig:
        problems.append("API trigger %r has triggerId %r, expected %r"
                        % (tc.get("label"), tc.get("triggerId"), want_trig))

for bad in ["apigee-nonprod-511322", "ef911070c468726ff-tp", "__PROD_",
            "sar-kpi-db-dev", "sar-kpi-db-staging", "sar-kpi-get-dev", "sar-kpi-get-staging"]:
    if bad in text:
        problems.append("the version contains the non-prod or unresolved value %r" % bad)

for p in problems:
    print("ASSERTION FAILED: " + p)
sys.exit(1 if problems else 0)
' "${SHA}" < "${RESP}" >&2 || {
  echo "ERROR: ${NAME} version ${VERSION} failed the post-apply assertions above." >&2
  exit 1
}

echo "OK: ${NAME} version ${VERSION}: userLabel ${SHA}, connection sar-kpi-db-prod, trigger api_trigger/${NAME}." >&2
if [[ -n "${OUT_FILE}" ]]; then
  echo "${VERSION}" > "${OUT_FILE}"
fi
echo "${VERSION}"
