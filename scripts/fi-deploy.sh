#!/usr/bin/env bash
# Deploys a fault-injection scratch revision of sar-mot-kpis-v1 to dev (P6, D39 recipes).
#
#   bash scripts/fi-deploy.sh <fi06|fi07|fi13|fi16|fi16b>
#
# Org and environment are fixed (apigee-nonprod-511322 / dev); nothing else can be targeted.
# Steps:
#   1. Record the currently deployed (normal) revision in .fi-state/baseline-revision, only if no
#      baseline is recorded yet, so repeated scenarios keep the original baseline.
#   2. Create fresh versioned KVMs sar-mot-kpis-{config,errors}-<scenario>-<sha>-<epoch minutes>
#      with the normal dev values (KVM values are cached 300 s, so every run uses a new name),
#      then override exactly ONE config entry:
#        fi06  spikeArrestRate=2pm                 row 6  SpikeArrestViolation -> 429
#        fi07  quotaLimit=2 (interval 1 minute)     row 7  QuotaViolation -> 429
#        fi13  triggerName=api_trigger/does-not-exist   row 13 integration failure -> 500
#        fi16  spikeArrestRate=abc                  row 16 unmapped fault -> 500 ERR-SYS-500
#        fi16b quotaTimeUnit=fortnight              row 16 fallback if fi16 returns 200
#   3. Stamp __KVM_VERSION__ in the proxy bundle with that suffix, deploy with Maven (-Pdev),
#      and always revert the stamp (git checkout), even on failure.
#   4. Wait for READY, check the new revision is live, then wait for propagation.
# Restore the baseline with: bash scripts/fi-restore.sh
# Nothing is deleted: scratch KVMs and revisions are listed in .fi-state/history.log for manual
# cleanup (AGENTS.md rule 3). The access token is never printed.
set -euo pipefail
set +x

readonly ORG="apigee-nonprod-511322"
readonly ENV_NAME="dev"
readonly PROXY="sar-mot-kpis-v1"
readonly PROXY_DIR="src/main/apigee/apiproxies"
readonly BUNDLE="${PROXY_DIR}/${PROXY}/apiproxy"
readonly POM="${PROXY_DIR}/${PROXY}/pom.xml"
readonly STATE_DIR=".fi-state"
readonly BASELINE_FILE="${STATE_DIR}/baseline-revision"
readonly PROPAGATION_SECONDS=60

usage() {
  echo "usage: $0 <fi06|fi07|fi13|fi16|fi16b>   (org ${ORG}, env ${ENV_NAME}; no other arguments)" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

SCENARIO="$1"
case "${SCENARIO}" in
  fi06)  KEY="spikeArrestRate"; VALUE="2pm" ;;
  fi07)  KEY="quotaLimit";      VALUE="2" ;;
  fi13)  KEY="triggerName";     VALUE="api_trigger/does-not-exist" ;;
  fi16)  KEY="spikeArrestRate"; VALUE="abc" ;;
  fi16b) KEY="quotaTimeUnit";   VALUE="fortnight" ;;
  *)
    usage
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

# The trap below reverts the proxy tree with git checkout: refuse if it has local changes.
if [[ -n "$(git status --porcelain -- "${PROXY_DIR}")" ]]; then
  echo "Refusing: ${PROXY_DIR} has uncommitted changes (the stamp revert would discard them)." >&2
  exit 1
fi
if ! grep -rqs "__KVM_VERSION__" "${BUNDLE}"; then
  echo "Refusing: no __KVM_VERSION__ placeholder in ${BUNDLE}." >&2
  exit 1
fi

mkdir -p "${STATE_DIR}"

# 1. Baseline (only once).
if [[ -s "${BASELINE_FILE}" ]]; then
  BASELINE="$(tr -d '\r\n[:space:]' < "${BASELINE_FILE}")"
  echo "Baseline already recorded: revision ${BASELINE} (kept)"
else
  bash scripts/get-deployed-revision.sh "${ORG}" "${ENV_NAME}" "${PROXY}" "${STATE_DIR}/baseline.tmp"
  BASELINE="$(tr -d '\r\n[:space:]' < "${STATE_DIR}/baseline.tmp")"
  rm -f "${STATE_DIR}/baseline.tmp"
  if [[ ! "${BASELINE}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: could not read the deployed revision of ${PROXY} in ${ENV_NAME}; no baseline recorded." >&2
    exit 1
  fi
  echo "${BASELINE}" > "${BASELINE_FILE}"
  echo "Baseline recorded: revision ${BASELINE}"
fi
if [[ ! "${BASELINE}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: invalid baseline in ${BASELINE_FILE}" >&2
  exit 1
fi

# 2. Fresh versioned KVMs, then one override.
SHORT_SHA="$(git rev-parse --short=7 HEAD)"
SUFFIX="${SCENARIO}-${SHORT_SHA}-$(( $(date +%s) / 60 ))"
CONFIG_MAP="sar-mot-kpis-config-${SUFFIX}"
echo "Scenario ${SCENARIO}: KVM suffix ${SUFFIX}, override ${KEY}=${VALUE}"

bash scripts/create-versioned-kvm.sh "${ORG}" "${ENV_NAME}" "${SUFFIX}"

TOKEN="$(gcloud auth print-access-token --quiet 2>/dev/null | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: no access token from gcloud" >&2
  exit 1
fi

WORK="$(mktemp -d)"
cleanup() {
  git checkout -- "${PROXY_DIR}" || echo "WARNING: could not revert ${PROXY_DIR}; run: git checkout -- ${PROXY_DIR}" >&2
  rm -rf "${WORK}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

API="https://apigee.googleapis.com/v1/organizations/${ORG}/environments/${ENV_NAME}/keyvaluemaps"
HTTP_CODE="$(curl -sS -o "${WORK}/put.json" -w "%{http_code}" -X PUT \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"${KEY}\",\"value\":\"${VALUE}\"}" \
  "${API}/${CONFIG_MAP}/entries/${KEY}")"
if [[ ! "${HTTP_CODE}" =~ ^20[01]$ ]]; then
  echo "ERROR: override of ${CONFIG_MAP}/${KEY} failed (HTTP ${HTTP_CODE}):" >&2
  cat "${WORK}/put.json" >&2 || true
  exit 1
fi
echo "Override set: ${CONFIG_MAP}/${KEY}=${VALUE}"

# 3. Stamp (reverted by the EXIT trap), deploy.
grep -rl "__KVM_VERSION__" "${BUNDLE}" | while IFS= read -r f; do
  sed -i "s/__KVM_VERSION__/${SUFFIX}/g" "${f}"
done
if grep -rqs "__KVM_VERSION__" "${BUNDLE}"; then
  echo "ERROR: __KVM_VERSION__ still present after stamping" >&2
  exit 1
fi
CHANGED="$(git diff --name-only -- "${BUNDLE}" | wc -l | tr -d '[:space:]')"
if [[ "${CHANGED}" != "2" ]]; then
  echo "ERROR: expected exactly 2 stamped files (KVM-GetConfig, KVM-GetErrorMessage), got ${CHANGED}" >&2
  exit 1
fi

echo "Deploying ${PROXY} to ${ENV_NAME} with Maven (token not shown)"
# Output filtered so the token can never appear in the log.
mvn -B -q -f "${POM}" clean install -Pdev -Dbearer="${TOKEN}" 2>&1 | sed "s/${TOKEN}/***TOKEN***/g"

# Revert the stamp now (the trap does it again harmlessly).
git checkout -- "${PROXY_DIR}"

# 4. READY, live check, propagation. wait-for-deployment writes <env>_revision.txt in the cwd.
(cd "${STATE_DIR}" && bash ../scripts/wait-for-deployment.sh "${ORG}" "${ENV_NAME}" "${PROXY}" 600)
NEW_REV="$(cd "${STATE_DIR}" && tr -d '\r\n[:space:]' < "${ENV_NAME}_revision.txt")"
if [[ ! "${NEW_REV}" =~ ^[0-9]+$ ]] || (( NEW_REV <= BASELINE )); then
  echo "ERROR: deployed revision '${NEW_REV}' is not newer than the baseline ${BASELINE}" >&2
  exit 1
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${SCENARIO} revision=${NEW_REV} kvms=sar-mot-kpis-config-${SUFFIX},sar-mot-kpis-errors-${SUFFIX} override=${KEY}=${VALUE}" \
  >> "${STATE_DIR}/history.log"
echo "${SCENARIO}" > "${STATE_DIR}/last-scenario"

echo "Revision ${NEW_REV} is READY; waiting ${PROPAGATION_SECONDS}s for propagation (and an empty rate window)"
sleep "${PROPAGATION_SECONDS}"

echo "Ready for: bash tests/run-newman.sh dev --folder \"<FI folder>\" --env-var faultScenario=${SCENARIO}"
echo "Restore afterwards with: bash scripts/fi-restore.sh"
