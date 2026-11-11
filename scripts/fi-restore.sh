#!/usr/bin/env bash
# Redeploys the baseline revision recorded by scripts/fi-deploy.sh to dev, waits until it is
# READY and live, then removes the fault-injection state.
#
#   bash scripts/fi-restore.sh            (no arguments)
#
# Org and environment are fixed (apigee-nonprod-511322 / dev). Nothing is deleted in Apigee: the
# scratch revisions and KVMs listed in .fi-state/history.log stay for manual cleanup
# (AGENTS.md rule 3); history.log is kept.
set -euo pipefail
set +x

readonly ORG="apigee-nonprod-511322"
readonly ENV_NAME="dev"
readonly PROXY="sar-mot-kpis-v1"
readonly STATE_DIR=".fi-state"
readonly BASELINE_FILE="${STATE_DIR}/baseline-revision"

if [[ $# -ne 0 ]]; then
  echo "usage: $0   (no arguments; org ${ORG}, env ${ENV_NAME})" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

if [[ ! -s "${BASELINE_FILE}" ]]; then
  echo "No baseline recorded in ${BASELINE_FILE}: nothing to restore." >&2
  exit 1
fi
BASELINE="$(tr -d '\r\n[:space:]' < "${BASELINE_FILE}")"
if [[ ! "${BASELINE}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: invalid baseline '${BASELINE}' in ${BASELINE_FILE}" >&2
  exit 1
fi

# The baseline is only honoured while dev is on it or on one of our scratch revisions; otherwise
# someone else deployed dev since and restoring would roll it back silently.
LIVE_NOW="$(bash scripts/get-deployed-revision.sh "${ORG}" "${ENV_NAME}" "${PROXY}" | tr -d '\r\n[:space:]')"
if [[ ! "${LIVE_NOW}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not read the deployed revision of ${PROXY} in ${ENV_NAME}." >&2
  exit 1
fi
if [[ "${LIVE_NOW}" != "${BASELINE}" ]] \
   && ! grep -Eqs "(^| )revision=${LIVE_NOW}( |$)" "${STATE_DIR}/history.log"; then
  echo "Refusing: stale ${STATE_DIR}: dev is on revision ${LIVE_NOW}, which is neither the baseline ${BASELINE} nor a scratch revision in ${STATE_DIR}/history.log." >&2
  echo "Someone else deployed dev since. Check it, then remove ${BASELINE_FILE} by hand." >&2
  exit 1
fi

on_exit() {
  local rc=$?
  if [[ "${rc}" != "0" ]]; then
    echo "fi-restore failed: dev may still be on a scratch revision - fix the cause and re-run bash scripts/fi-restore.sh (.fi-state is kept)." >&2
  fi
  exit "${rc}"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

echo "Restoring ${PROXY} revision ${BASELINE} in ${ENV_NAME} (live now: ${LIVE_NOW})"
bash scripts/deploy-revision.sh "${ORG}" "${ENV_NAME}" "${PROXY}" "${BASELINE}"
(cd "${STATE_DIR}" && bash ../scripts/wait-for-deployment.sh "${ORG}" "${ENV_NAME}" "${PROXY}" 600 "${BASELINE}")

# The scratch revision may still be listed for a moment after the override deploy.
LIVE=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  LIVE="$(bash scripts/get-deployed-revision.sh "${ORG}" "${ENV_NAME}" "${PROXY}" | tr -d '\r\n[:space:]')"
  if [[ "${LIVE}" == "${BASELINE}" ]]; then
    break
  fi
  echo "Deployed revision is '${LIVE:-none}', waiting for ${BASELINE}"
  sleep 10
done
if [[ "${LIVE}" != "${BASELINE}" ]]; then
  echo "ERROR: deployed revision is '${LIVE:-none}', expected ${BASELINE}; state kept in ${STATE_DIR}" >&2
  exit 1
fi

rm -f "${BASELINE_FILE}" "${STATE_DIR}/last-scenario" "${STATE_DIR}/${ENV_NAME}_revision.txt"
echo "Restored revision ${BASELINE}. Scratch revisions/KVMs for manual cleanup: ${STATE_DIR}/history.log"
