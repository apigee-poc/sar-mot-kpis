#!/usr/bin/env bash
# Post-apply assertion on the ACTIVE (published) version of sar-kpi-get-<env> (PLAN P7 step 5).
#
#   assert-integration.sh <dev|staging> <short_sha> [output_file]
#
#   env        dev or staging only; project apigee-nonprod-511322 and region us-central1 fixed.
#   short_sha  7-40 lowercase hex: the expected userLabel.
#
# Gets the ACTIVE version id with scripts/get-published-integration-version.sh (fails closed),
# fetches that version and asserts:
#   (a) userLabel == short_sha
#   (b) exactly one GenericConnectorTask, and its parameters.config jsonValue connectionName ends
#       in /connections/sar-kpi-db-<env>; the other env's connection name (sar-kpi-db-<other>)
#       appears nowhere in the version
#   (c) every API trigger has triggerId api_trigger/sar-kpi-get-<env> (at least one), and
#       api_trigger/sar-kpi-get-<other> appears nowhere
# Output on success: the version id on stdout (and in [output_file] when given).
# Exit: 0 all assertions hold; 1 no ACTIVE version, API/parse error, or a failed assertion (the
#       message names it); 2 bad arguments (checked before any network call).
# Token: gcloud auth print-access-token, else /workspace/.token. Never printed.
# Needs: curl, Python 3 (scripts/lib/python.sh).
set -euo pipefail
set +x

readonly PROJECT="apigee-nonprod-511322"
readonly REGION="us-central1"

usage() {
  echo "usage: $(basename "$0") <dev|staging> <short_sha> [output_file]   (project ${PROJECT})" >&2
}
if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi
ENV_NAME="$1"; SHA="$2"; OUT_FILE="${3:-}"
case "${ENV_NAME}" in
  dev) OTHER="staging" ;;
  staging) OTHER="dev" ;;
  prod)
    echo "Refusing prod: prod is checked only by cloudbuild-prod.yaml (AGENTS.md rule 2)." >&2
    exit 2
    ;;
  *)
    usage
    exit 2
    ;;
esac
if [[ ! "${SHA}" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "ERROR: short_sha must be 7-40 lowercase hex characters." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# PY = first working Python 3: python3, python, else gcloud's bundled one (scripts/lib/python.sh).
source "${SCRIPT_DIR}/lib/python.sh"
NAME="sar-kpi-get-${ENV_NAME}"

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
import json, sys
env, other, sha = sys.argv[1], sys.argv[2], sys.argv[3]
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

want_conn = "/connections/sar-kpi-db-" + env
connectors = [t for t in v.get("taskConfigs", []) if t.get("task") == "GenericConnectorTask"]
if len(connectors) != 1:
    problems.append("expected exactly 1 GenericConnectorTask, found %d" % len(connectors))
else:
    t = connectors[0]
    conn = ""
    try:
        cfg = t["parameters"]["config"]["value"]["jsonValue"]
        conn = json.loads(cfg)["connection"]["connectionName"]
    except Exception:
        problems.append("task %s (%s): parameters.config.value.jsonValue has no connection.connectionName"
                        % (t.get("taskId"), t.get("displayName")))
    if conn and not conn.endswith(want_conn):
        problems.append("task %s connectionName is %r, expected it to end in %r"
                        % (t.get("taskId"), conn, want_conn))
if "sar-kpi-db-" + other in text:
    problems.append("the version references the %s connection sar-kpi-db-%s" % (other, other))

want_trig = "api_trigger/sar-kpi-get-" + env
api_triggers = [tc for tc in v.get("triggerConfigs", []) if tc.get("triggerType") == "API"]
if not api_triggers:
    problems.append("no API trigger found")
for tc in api_triggers:
    if tc.get("triggerId") != want_trig:
        problems.append("API trigger %r has triggerId %r, expected %r"
                        % (tc.get("label"), tc.get("triggerId"), want_trig))
if "api_trigger/sar-kpi-get-" + other in text:
    problems.append("the version references the %s trigger api_trigger/sar-kpi-get-%s" % (other, other))

for p in problems:
    print("ASSERTION FAILED: " + p)
sys.exit(1 if problems else 0)
' "${ENV_NAME}" "${OTHER}" "${SHA}" < "${RESP}" >&2 || {
  echo "ERROR: ${NAME} version ${VERSION} failed the post-apply assertions above." >&2
  exit 1
}

echo "OK: ${NAME} version ${VERSION}: userLabel ${SHA}, connection sar-kpi-db-${ENV_NAME}, trigger api_trigger/${NAME}." >&2
if [[ -n "${OUT_FILE}" ]]; then
  echo "${VERSION}" > "${OUT_FILE}"
fi
echo "${VERSION}"
