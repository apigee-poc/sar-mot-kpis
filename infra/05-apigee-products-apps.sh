#!/usr/bin/env bash
# Creates the API products, the developer and the two developer apps used by the SAR MOT KPI
# proxy in the NON-PROD Apigee organisation (envs dev and staging). Credentials go straight
# into Secret Manager; they are never printed, logged or written to a file.
#
#   sar-mot-kpis-product   path /kpis/**, all HTTP methods, envs dev + staging
#   sar-mot-other-product  path /other/** (no /kpis/**), used for the 403 test
#   developer              mot-poc@example.com
#   mot-poc-app            has sar-mot-kpis-product
#   mot-poc-other-app      has only sar-mot-other-product
#
# Secret Manager (apigee-nonprod-511322):
#   sar-mot-poc-app-api-key,       sar-mot-poc-app-api-secret
#   sar-mot-poc-other-app-api-key, sar-mot-poc-other-app-api-secret
#
# Usage: 05-apigee-products-apps.sh [env_file]
# Run it after the proxy has been deployed once (the product lists the proxy name).
# Idempotent: existing products, developer and apps are left as they are (409 / 200 on GET).
# A secret VERSION is added only when the secret has no enabled version yet.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-${SCRIPT_DIR}/env/nonprod.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${ENV_FILE}"

# Hard guard (AGENTS.md rule 2): non-prod only.
PROD_PROJECT="apigee-prod-511508"
NONPROD_PROJECT="apigee-nonprod-511322"
if [[ "${PROJECT_ID}" == "${PROD_PROJECT}" || "${PROJECT_ID}" != "${NONPROD_PROJECT}" ]]; then
  echo "ERROR: this script targets ${NONPROD_PROJECT} only (PROJECT_ID='${PROJECT_ID}')." >&2
  exit 1
fi

ORG="${PROJECT_ID}"
PROXY_NAME="sar-mot-kpis-v1"
PRODUCT_MAIN="sar-mot-kpis-product"
PRODUCT_OTHER="sar-mot-other-product"
DEVELOPER_EMAIL="mot-poc@example.com"
APP_MAIN="mot-poc-app"
APP_OTHER="mot-poc-other-app"
SECRET_MAIN_KEY="sar-mot-poc-app-api-key"
SECRET_MAIN_SECRET="sar-mot-poc-app-api-secret"
SECRET_OTHER_KEY="sar-mot-poc-other-app-api-key"
SECRET_OTHER_SECRET="sar-mot-poc-other-app-api-secret"

API="https://apigee.googleapis.com/v1/organizations/${ORG}"
PY="$(command -v python3 || gcloud info --format='value(basic.python_location)')"

TOKEN="$(gcloud auth print-access-token 2>/dev/null || true)"
TOKEN="$(echo "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: Unable to acquire an access token (gcloud auth login or impersonation)." >&2
  exit 1
fi

echo "============================================================"
echo "Apigee products, developer and apps in org ${ORG}"
echo "============================================================"

# api_call <METHOD> <URL> [JSON_BODY]
# Sets HTTP_CODE and BODY (in memory only; BODY may contain credentials, so it is never echoed
# by this function).
HTTP_CODE=""
BODY=""
api_call() {
  local method="$1" url="$2" data="${3:-}" out
  if [[ -n "${data}" ]]; then
    out="$(curl -sS -w $'\n%{http_code}' -X "${method}" \
      -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
      -d "${data}" "${url}")"
  else
    out="$(curl -sS -w $'\n%{http_code}' -X "${method}" \
      -H "Authorization: Bearer ${TOKEN}" "${url}")"
  fi
  HTTP_CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

# fail_call <what>: prints the HTTP code and, only for error responses of calls that cannot carry
# credentials, the error body.
fail_call() {
  echo "ERROR: ${1} failed (HTTP ${HTTP_CODE})." >&2
  if [[ "${2:-}" == "show-body" ]]; then
    printf '%s\n' "${BODY}" >&2
  fi
  exit 1
}

# --- API products -----------------------------------------------------------------------
# No verb restriction on purpose: apiResources without methods allows every method, so a
# non-GET request reaches the proxy and gets 405 from the proxy (a GET-only operation would
# turn it into 403). Quota is left to the config KVM (AM-SetQuotaValues falls back to it).
create_product() {
  local name="$1" display="$2" path="$3" body
  body="$("${PY}" -c '
import json, sys
name, display, path, proxy = sys.argv[1:5]
print(json.dumps({
    "name": name,
    "displayName": display,
    "description": "SAR MOT KPI data sharing POC (" + path + ")",
    "approvalType": "auto",
    "environments": ["dev", "staging"],
    "proxies": [proxy],
    "apiResources": [path],
    "attributes": [{"name": "access", "value": "internal"}],
}))' "${name}" "${display}" "${path}" "${PROXY_NAME}")"
  api_call GET "${API}/apiproducts/${name}"
  if [[ "${HTTP_CODE}" == "200" ]]; then
    echo "API product ${name} already exists."
    return
  fi
  if [[ "${HTTP_CODE}" != "404" ]]; then
    fail_call "GET API product ${name}" show-body
  fi
  api_call POST "${API}/apiproducts" "${body}"
  if [[ "${HTTP_CODE}" =~ ^20[01]$ ]]; then
    echo "API product ${name} created."
  elif [[ "${HTTP_CODE}" == "409" ]]; then
    echo "API product ${name} already exists (409)."
  else
    fail_call "create API product ${name}" show-body
  fi
}

create_product "${PRODUCT_MAIN}" "SAR MOT KPIs" "/kpis/**"
create_product "${PRODUCT_OTHER}" "SAR MOT Other (403 test)" "/other/**"

# --- Developer --------------------------------------------------------------------------
api_call GET "${API}/developers/${DEVELOPER_EMAIL}"
if [[ "${HTTP_CODE}" == "200" ]]; then
  echo "Developer ${DEVELOPER_EMAIL} already exists."
elif [[ "${HTTP_CODE}" == "404" ]]; then
  DEV_BODY="$("${PY}" -c '
import json, sys
print(json.dumps({"email": sys.argv[1], "firstName": "MOT", "lastName": "POC", "userName": "mot-poc"}))' "${DEVELOPER_EMAIL}")"
  api_call POST "${API}/developers" "${DEV_BODY}"
  if [[ "${HTTP_CODE}" =~ ^20[01]$ ]]; then
    echo "Developer ${DEVELOPER_EMAIL} created."
  elif [[ "${HTTP_CODE}" == "409" ]]; then
    echo "Developer ${DEVELOPER_EMAIL} already exists (409)."
  else
    fail_call "create developer" show-body
  fi
else
  fail_call "GET developer" show-body
fi

# --- Secret Manager helpers -------------------------------------------------------------
ensure_secret() {
  local secret="$1"
  if gcloud secrets describe "${secret}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    return
  fi
  echo "Creating Secret Manager secret ${secret}..."
  gcloud secrets create "${secret}" \
    --replication-policy="automatic" \
    --project="${PROJECT_ID}" \
    --quiet >/dev/null
}

secret_has_version() {
  gcloud secrets versions list "$1" --project="${PROJECT_ID}" \
    --filter="state:ENABLED" --format='value(name)' --limit=1 2>/dev/null | grep -q '^[0-9]'
}

# store_credential <secret-name> <field: consumerKey|consumerSecret>
# Reads the app JSON from $BODY, pipes the chosen field straight into Secret Manager.
# Adds a version only when the secret has none yet. Never prints the value.
store_credential() {
  local secret="$1" field="$2" value_len
  ensure_secret "${secret}"
  if secret_has_version "${secret}"; then
    echo "  ${secret}: already has a version, not overwritten."
    return
  fi
  # Length check only (no value printed): does the API reveal this field?
  value_len="$(printf '%s' "${BODY}" | "${PY}" -c '
import json, sys
creds = json.load(sys.stdin).get("credentials", [])
approved = [c for c in creds if c.get("status", "approved") == "approved"] or creds
print(len(approved[0].get(sys.argv[1], "")) if approved else 0)' "${field}")"
  if [[ "${value_len}" == "0" ]]; then
    echo "  WARNING: the Apigee API did not return ${field}; ${secret} NOT stored." >&2
    echo "           (rotate it in the console / re-create the app, then store it manually)." >&2
    return
  fi
  printf '%s' "${BODY}" | "${PY}" -c '
import json, sys
creds = json.load(sys.stdin).get("credentials", [])
approved = [c for c in creds if c.get("status", "approved") == "approved"] or creds
sys.stdout.write(approved[0][sys.argv[1]])' "${field}" \
    | gcloud secrets versions add "${secret}" --data-file=- --project="${PROJECT_ID}" --quiet >/dev/null
  echo "  ${secret}: version added."
}

# --- Developer apps ---------------------------------------------------------------------
# create_app <app> <product> <key-secret> <secret-secret>
create_app() {
  local app="$1" product="$2" key_secret="$3" secret_secret="$4" app_body
  app_body="$("${PY}" -c '
import json, sys
print(json.dumps({"name": sys.argv[1], "apiProducts": [sys.argv[2]]}))' "${app}" "${product}")"
  api_call GET "${API}/developers/${DEVELOPER_EMAIL}/apps/${app}"
  if [[ "${HTTP_CODE}" == "200" ]]; then
    echo "Developer app ${app} already exists."
  elif [[ "${HTTP_CODE}" == "404" ]]; then
    api_call POST "${API}/developers/${DEVELOPER_EMAIL}/apps" "${app_body}"
    if [[ "${HTTP_CODE}" =~ ^20[01]$ ]]; then
      echo "Developer app ${app} created with product ${product}."
    elif [[ "${HTTP_CODE}" == "409" ]]; then
      echo "Developer app ${app} already exists (409)."
      api_call GET "${API}/developers/${DEVELOPER_EMAIL}/apps/${app}"
      [[ "${HTTP_CODE}" == "200" ]] || fail_call "GET developer app ${app}"
    else
      fail_call "create developer app ${app}"
    fi
  else
    fail_call "GET developer app ${app}"
  fi
  # BODY now holds the app including its credentials (kept in memory only).
  store_credential "${key_secret}" "consumerKey"
  store_credential "${secret_secret}" "consumerSecret"
  BODY=""
}

create_app "${APP_MAIN}" "${PRODUCT_MAIN}" "${SECRET_MAIN_KEY}" "${SECRET_MAIN_SECRET}"
create_app "${APP_OTHER}" "${PRODUCT_OTHER}" "${SECRET_OTHER_KEY}" "${SECRET_OTHER_SECRET}"

echo "============================================================"
echo "SUCCESS: products, developer, apps and credential secrets are in place."
echo "Secrets (not printed): ${SECRET_MAIN_KEY}, ${SECRET_MAIN_SECRET},"
echo "                       ${SECRET_OTHER_KEY}, ${SECRET_OTHER_SECRET}"
echo "============================================================"
