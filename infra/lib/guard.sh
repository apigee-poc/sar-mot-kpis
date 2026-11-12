#!/usr/bin/env bash
# Sourced helper (P8): the prod guard of the infra scripts (AGENTS.md rule 2, D55, D58).
#
#   source "${SCRIPT_DIR}/lib/guard.sh"; infra_guard "<script name>"     (right after the env file)
#
# Reads PROJECT_ID and CB_DEPLOY_SA (from the env file) and BUILD_ID / TARGET (process env).
#   prod project (apigee-prod-511508): allowed only inside Cloud Build (BUILD_ID non-empty) AND
#     with TARGET=prod, and only with CB_DEPLOY_SA = cb-deploy-prod@ci-cd-511313.
#   nonprod project (apigee-nonprod-511322): refused when TARGET=prod (mismatch) or when
#     CB_DEPLOY_SA is the prod build account; otherwise unchanged (no BUILD_ID needed).
#   any other or empty PROJECT_ID: refused.
# On refusal: a clear message on stderr and exit 2, before any gcloud/curl call.
# Sets (exported for the calling script): IS_PROD=1 for the prod project, IS_PROD=0 otherwise.
# This is defence in depth: BUILD_ID/TARGET can be set by hand. The real control is IAM
# (cb-deploy-nonprod holds no role on the prod project, D58).

INFRA_PROD_PROJECT="apigee-prod-511508"
INFRA_NONPROD_PROJECT="apigee-nonprod-511322"
INFRA_PROD_BUILD_SA="cb-deploy-prod@ci-cd-511313.iam.gserviceaccount.com"
INFRA_NONPROD_BUILD_SA="cb-deploy-nonprod@ci-cd-511313.iam.gserviceaccount.com"

infra_guard() {
  local who="${1:-infra script}"
  local project="${PROJECT_ID:-}" target="${TARGET:-}" build="${BUILD_ID:-}" sa="${CB_DEPLOY_SA:-}"
  case "${project}" in
    "${INFRA_PROD_PROJECT}")
      if [[ -z "${build}" ]]; then
        echo "REFUSED (${who}): ${INFRA_PROD_PROJECT} is changed only inside Cloud Build (BUILD_ID is not set). Prod runs only via cloudbuild-infra-prod.yaml (AGENTS.md rule 2)." >&2
        exit 2
      fi
      if [[ "${target}" != "prod" ]]; then
        echo "REFUSED (${who}): PROJECT_ID is ${INFRA_PROD_PROJECT} but TARGET is '${target}' (TARGET=prod is required)." >&2
        exit 2
      fi
      if [[ "${sa}" != "${INFRA_PROD_BUILD_SA}" ]]; then
        echo "REFUSED (${who}): on ${INFRA_PROD_PROJECT} CB_DEPLOY_SA must be ${INFRA_PROD_BUILD_SA} (got '${sa}')." >&2
        exit 2
      fi
      IS_PROD=1
      ;;
    "${INFRA_NONPROD_PROJECT}")
      if [[ "${target}" == "prod" ]]; then
        echo "REFUSED (${who}): TARGET=prod but PROJECT_ID is ${INFRA_NONPROD_PROJECT} (env file / target mismatch)." >&2
        exit 2
      fi
      if [[ "${sa}" == "${INFRA_PROD_BUILD_SA}" ]]; then
        echo "REFUSED (${who}): the prod build account ${INFRA_PROD_BUILD_SA} is never granted on ${INFRA_NONPROD_PROJECT}." >&2
        exit 2
      fi
      IS_PROD=0
      ;;
    *)
      echo "REFUSED (${who}): unknown PROJECT_ID '${project}' (expected ${INFRA_NONPROD_PROJECT} or ${INFRA_PROD_PROJECT})." >&2
      exit 2
      ;;
  esac
  export IS_PROD
}
