#!/usr/bin/env bash
# Sourced helper (P8): the guard of every scripts/*-prod.sh helper (AGENTS.md rule 2, D58).
#
#   source "${SCRIPT_DIR}/lib/prod-guard.sh"; prod_guard "<project or org the script targets>"
#
# Passes only when ALL hold, else prints a refusal on stderr and exits 2:
#   - BUILD_ID is non-empty (we run inside Cloud Build; the pipeline passes it as a step env var)
#   - TARGET=prod
#   - the given project/org is apigee-prod-511508 (the caller passes its own hard-coded constant,
#     never $PROJECT_ID: in Cloud Build that is the build project ci-cd-511313)
# Call it first, before any token, gcloud, curl, node or Python call.
# Defence in depth only: BUILD_ID/TARGET can be set by hand. The real control is IAM (D58).

readonly PROD_GUARD_PROJECT="apigee-prod-511508"

prod_guard() {
  local target_project="${1:-}"
  local who
  who="$(basename "${0}")"
  if [[ "${target_project}" != "${PROD_GUARD_PROJECT}" ]]; then
    echo "REFUSED (${who}): target '${target_project}' is not ${PROD_GUARD_PROJECT}." >&2
    exit 2
  fi
  if [[ -z "${BUILD_ID:-}" ]]; then
    echo "REFUSED (${who}): prod is changed only inside Cloud Build (BUILD_ID is not set; cloudbuild-prod.yaml, AGENTS.md rule 2)." >&2
    exit 2
  fi
  if [[ "${TARGET:-}" != "prod" ]]; then
    echo "REFUSED (${who}): TARGET must be 'prod' (got '${TARGET:-}')." >&2
    exit 2
  fi
}
