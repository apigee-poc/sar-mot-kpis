#!/usr/bin/env bash
# Creates the API product, the developers and the two developer apps of the SAR MOT KPI proxy in
# the PROD Apigee organisation (env prod). PROD ONLY: runs only inside Cloud Build with TARGET=prod
# (cloudbuild-infra-prod.yaml, D55) and refuses any other project (infra/05 is the non-prod one).
# Credentials go straight into prod Secret Manager; they are never printed, logged or written to
# a file.
#
#   sar-mot-kpis-product   path /kpis/**, all HTTP methods, env prod, auto-approve
#   developer              MOT_DEVELOPER_EMAIL (infra/env/prod.env; default placeholder
#                          mot-poc@example.com: REPLACE with the real MOT contact before the run;
#                          an @example.com address is refused unless ALLOW_PLACEHOLDER_MOT_EMAIL=1)
#   mot-app                MOT handover app (sar-mot-kpis-product); credentials handed over out of
#                          band by a person. The build SA gets NO direct grant on them, but while it
#                          holds roles/apigee.developerAdmin (app GET returns the credentials) or
#                          roles/secretmanager.admin it can still read them (D67).
#   developer              SMOKE_DEVELOPER_EMAIL (default sar-mot-smoke@example.com)
#   mot-smoke-app          pipeline smoke app (sar-mot-kpis-product), used by
#                          scripts/run-newman-prod.sh
#
# Secret Manager (prod project):
#   sar-mot-app-api-key,       sar-mot-app-api-secret        (MOT handover)
#   sar-mot-smoke-app-api-key, sar-mot-smoke-app-api-secret  (CB_DEPLOY_SA gets secretAccessor)
#
# Usage: 06-apigee-prod-product-app.sh [env_file=infra/env/prod.env]
# Env: BUILD_ID (non-empty), TARGET=prod (infra/lib/guard.sh); MOT_DEVELOPER_EMAIL optional.
# Idempotent: existing product, developers and apps are left as they are (409 / 200 on GET).
# A secret VERSION is added only when the secret has no enabled version yet.
# Needs: gcloud, curl, Python 3 (cloud-sdk:slim).
# Exit: 0 ok; 1 API/gcloud failure, or a placeholder MOT email (before any call); 2 refused by
#       the guard (wrong project, not in Cloud Build, TARGET is not prod, wrong build SA).
set -euo pipefail
# Never trace: shell variables below hold API credentials (guards against `bash -x`).
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${1:-${SCRIPT_DIR}/env/prod.env}"
if [[ $# -gt 1 ]]; then
  echo "usage: $(basename "$0") [env_file=infra/env/prod.env]" >&2
  exit 2
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${ENV_FILE}"

# Guard (AGENTS.md rule 2): Cloud Build + TARGET=prod + the prod build SA, and prod only.
# shellcheck source=lib/guard.sh
source "${SCRIPT_DIR}/lib/guard.sh"
infra_guard "$(basename "${BASH_SOURCE[0]}")"
if [[ "${IS_PROD}" != "1" ]]; then
  echo "REFUSED ($(basename "$0")): prod only; the non-prod products and apps are infra/05." >&2
  exit 2
fi

ORG="${PROJECT_ID}"
APIGEE_ENV="${APIGEE_ENV:-prod}"
PROXY_NAME="sar-mot-kpis-v1"
PRODUCT_MAIN="sar-mot-kpis-product"
DEVELOPER_EMAIL="${MOT_DEVELOPER_EMAIL:-mot-poc@example.com}"
SMOKE_DEVELOPER="${SMOKE_DEVELOPER_EMAIL:-sar-mot-smoke@example.com}"
APP_MOT="mot-app"
APP_SMOKE="mot-smoke-app"
SECRET_MOT_KEY="sar-mot-app-api-key"
SECRET_MOT_SECRET="sar-mot-app-api-secret"
SECRET_SMOKE_KEY="sar-mot-smoke-app-api-key"
SECRET_SMOKE_SECRET="sar-mot-smoke-app-api-secret"

EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
for e in "${DEVELOPER_EMAIL}" "${SMOKE_DEVELOPER}"; do
  if [[ ! "${e}" =~ ${EMAIL_RE} ]]; then
    echo "ERROR: '${e}' is not a valid developer email." >&2
    exit 1
  fi
done
# The MOT developer is effectively permanent: its app's credentials go into secrets that are never
# overwritten, and its email is the rate identifier (D37, D63). So a placeholder (any
# @example.com address, including the default mot-poc@example.com) is REFUSED, unless
# ALLOW_PLACEHOLDER_MOT_EMAIL=1 is set on purpose (a throw-away demo). No pipeline step passes
# environment variables through, so the opt-in only works when it is committed to
# infra/env/prod.env (visible in review). Checked before any tool call (P8 final review M6, D67).
case "${DEVELOPER_EMAIL,,}" in
  *@example.com)
    if [[ "${ALLOW_PLACEHOLDER_MOT_EMAIL:-0}" != "1" ]]; then
      echo "ERROR: MOT_DEVELOPER_EMAIL is the placeholder '${DEVELOPER_EMAIL}'. Commit the real MOT developer" >&2
      echo "       email to infra/env/prod.env first (DEPLOYMENT.md prerequisite 3), or set" >&2
      echo "       ALLOW_PLACEHOLDER_MOT_EMAIL=1 there on purpose. Nothing was created by infra/06." >&2
      exit 1
    fi
    echo "WARNING: MOT_DEVELOPER_EMAIL is the placeholder '${DEVELOPER_EMAIL}' (ALLOW_PLACEHOLDER_MOT_EMAIL=1)." >&2
    echo "         mot-app and its secrets will belong to this placeholder developer for good." >&2
    ;;
esac

API="https://apigee.googleapis.com/v1/organizations/${ORG}"
# PY = first working Python 3 (scripts/lib/python.sh).
# shellcheck source=../scripts/lib/python.sh
source "${REPO_ROOT}/scripts/lib/python.sh"

TOKEN="$(gcloud auth print-access-token 2>/dev/null || ([ -f /workspace/.token ] && cat /workspace/.token) || true)"
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "ERROR: Unable to acquire an access token (gcloud or /workspace/.token)." >&2
  exit 1
fi

echo "============================================================"
echo "Apigee product, developers and apps in org ${ORG} (env ${APIGEE_ENV})"
echo "============================================================"

# api_call <METHOD> <URL> [JSON_BODY]: sets HTTP_CODE and BODY (in memory only; BODY may contain
# credentials, so it is never echoed by this function). A curl/network error stops the script.
HTTP_CODE=""
BODY=""
# SAFE_BODY=1 only for responses that cannot carry credentials (everything except .../apps...).
SAFE_BODY=0
api_call() {
  local method="$1" url="$2" data="${3:-}" out
  case "${url}" in
    */apps|*/apps/*|*/apps?*) SAFE_BODY=0 ;;
    *) SAFE_BODY=1 ;;
  esac
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

# fail_call <what> [show-body]: HTTP code and, for non-app calls only, the error body.
fail_call() {
  echo "ERROR: ${1} failed (HTTP ${HTTP_CODE})." >&2
  if [[ "${2:-}" == "show-body" && "${SAFE_BODY}" == "1" ]]; then
    printf '%s\n' "${BODY}" >&2
  fi
  exit 1
}

# --- API product --------------------------------------------------------------------------
# No verb restriction (as infra/05): a non-GET request reaches the proxy and gets its 405.
# VERIFY on the first prod run: the product names the proxy before its first prod deployment.
PRODUCT_BODY="$("${PY}" -c '
import json, sys
name, display, path, proxy, env = sys.argv[1:6]
print(json.dumps({
    "name": name,
    "displayName": display,
    "description": "SAR MOT KPI data sharing (" + path + ")",
    "approvalType": "auto",
    "environments": [env],
    "proxies": [proxy],
    "apiResources": [path],
    "attributes": [{"name": "access", "value": "internal"}],
}))' "${PRODUCT_MAIN}" "SAR MOT KPIs" "/kpis/**" "${PROXY_NAME}" "${APIGEE_ENV}" | tr -d '\r')"
api_call GET "${API}/apiproducts/${PRODUCT_MAIN}"
if [[ "${HTTP_CODE}" == "200" ]]; then
  echo "API product ${PRODUCT_MAIN} already exists."
elif [[ "${HTTP_CODE}" == "404" ]]; then
  api_call POST "${API}/apiproducts" "${PRODUCT_BODY}"
  if [[ "${HTTP_CODE}" =~ ^20[01]$ ]]; then
    echo "API product ${PRODUCT_MAIN} created."
  elif [[ "${HTTP_CODE}" == "409" ]]; then
    echo "API product ${PRODUCT_MAIN} already exists (409)."
  else
    fail_call "create API product ${PRODUCT_MAIN}" show-body
  fi
else
  fail_call "GET API product ${PRODUCT_MAIN}" show-body
fi

# --- Developers ---------------------------------------------------------------------------
# ensure_developer <email> <firstName> <lastName> <userName>
ensure_developer() {
  local email="$1" body
  api_call GET "${API}/developers/${email}"
  if [[ "${HTTP_CODE}" == "200" ]]; then
    echo "Developer ${email} already exists."
    return
  fi
  [[ "${HTTP_CODE}" == "404" ]] || fail_call "GET developer ${email}" show-body
  body="$("${PY}" -c '
import json, sys
print(json.dumps({"email": sys.argv[1], "firstName": sys.argv[2], "lastName": sys.argv[3], "userName": sys.argv[4]}))' \
    "${email}" "$2" "$3" "$4" | tr -d '\r')"
  api_call POST "${API}/developers" "${body}"
  if [[ "${HTTP_CODE}" =~ ^20[01]$ ]]; then
    echo "Developer ${email} created."
  elif [[ "${HTTP_CODE}" == "409" ]]; then
    echo "Developer ${email} already exists (409)."
  else
    fail_call "create developer ${email}" show-body
  fi
}

ensure_developer "${DEVELOPER_EMAIL}" "MOT" "KPI" "mot-kpi"
ensure_developer "${SMOKE_DEVELOPER}" "SAR" "Smoke" "sar-mot-smoke"

# --- Secret Manager helpers ---------------------------------------------------------------
# A describe error other than NOT_FOUND (e.g. 403) stops the script instead of a blind create.
ensure_secret() {
  local secret="$1" err
  if err="$(gcloud secrets describe "${secret}" --project="${PROJECT_ID}" --quiet 2>&1 >/dev/null)"; then
    return
  fi
  if [[ "${err}" != *NOT_FOUND* && "${err}" != *"not found"* ]]; then
    echo "ERROR: could not check secret ${secret} (permission denied or API error)." >&2
    exit 1
  fi
  echo "Creating Secret Manager secret ${secret}..."
  gcloud secrets create "${secret}" \
    --replication-policy="automatic" \
    --project="${PROJECT_ID}" \
    --quiet >/dev/null
}

# Returns 0 if the secret has an enabled version, 1 if not. A gcloud failure (permissions,
# transient error) is NOT read as "no version": the script stops, so it never adds a duplicate.
secret_has_version() {
  local out
  if ! out="$(gcloud secrets versions list "$1" --project="${PROJECT_ID}" \
      --filter="state:ENABLED" --format='value(name.basename())' --limit=1 --quiet)"; then
    echo "ERROR: could not list the versions of secret $1." >&2
    exit 1
  fi
  out="$(printf '%s' "${out}" | tr -d '\r')"
  [[ "${out}" =~ ^[0-9]+$ ]]
}

# store_credential <secret-name> <field: consumerKey|consumerSecret>
# Reads the app JSON from $BODY and pipes the chosen field straight into Secret Manager.
# Adds a version only when the secret has none yet. Never prints the value.
store_credential() {
  local secret="$1" field="$2" value_len
  ensure_secret "${secret}"
  if secret_has_version "${secret}"; then
    echo "  ${secret}: already has a version, not overwritten."
    return
  fi
  value_len="$(printf '%s' "${BODY}" | "${PY}" -c '
import json, sys
creds = json.load(sys.stdin).get("credentials", [])
approved = [c for c in creds if c.get("status", "approved") == "approved"] or creds
print(len(approved[0].get(sys.argv[1], "")) if approved else 0)' "${field}" | tr -d '\r')"
  if [[ "${value_len}" == "0" ]]; then
    echo "ERROR: the Apigee API did not return ${field}; ${secret} NOT stored." >&2
    exit 1
  fi
  printf '%s' "${BODY}" | "${PY}" -c '
import json, sys
creds = json.load(sys.stdin).get("credentials", [])
approved = [c for c in creds if c.get("status", "approved") == "approved"] or creds
sys.stdout.write(approved[0][sys.argv[1]])' "${field}" \
    | gcloud secrets versions add "${secret}" --data-file=- --project="${PROJECT_ID}" --quiet >/dev/null
  echo "  ${secret}: version added."
}

# --- Developer apps -----------------------------------------------------------------------
# create_app <developer> <app> <product> <key-secret> <secret-secret>
create_app() {
  local dev="$1" app="$2" product="$3" key_secret="$4" secret_secret="$5" app_body
  app_body="$("${PY}" -c '
import json, sys
print(json.dumps({"name": sys.argv[1], "apiProducts": [sys.argv[2]]}))' "${app}" "${product}" | tr -d '\r')"
  api_call GET "${API}/developers/${dev}/apps/${app}"
  if [[ "${HTTP_CODE}" == "200" ]]; then
    echo "Developer app ${app} already exists."
  elif [[ "${HTTP_CODE}" == "404" ]]; then
    api_call POST "${API}/developers/${dev}/apps" "${app_body}"
    if [[ "${HTTP_CODE}" =~ ^20[01]$ ]]; then
      echo "Developer app ${app} created with product ${product}."
    elif [[ "${HTTP_CODE}" == "409" ]]; then
      echo "Developer app ${app} already exists (409)."
      api_call GET "${API}/developers/${dev}/apps/${app}"
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

create_app "${DEVELOPER_EMAIL}" "${APP_MOT}" "${PRODUCT_MAIN}" "${SECRET_MOT_KEY}" "${SECRET_MOT_SECRET}"
create_app "${SMOKE_DEVELOPER}" "${APP_SMOKE}" "${PRODUCT_MAIN}" "${SECRET_SMOKE_KEY}" "${SECRET_SMOKE_SECRET}"

# --- Smoke secret access for cloudbuild-prod.yaml -------------------------------------------
# Only the two smoke secrets get a direct grant; the MOT handover secrets get none. (The build SA
# can still reach them through developerAdmin / secretmanager.admin while it holds those, D67.)
for secret in "${SECRET_SMOKE_KEY}" "${SECRET_SMOKE_SECRET}"; do
  echo "Granting roles/secretmanager.secretAccessor on secret ${secret} to ${CB_DEPLOY_SA}..."
  gcloud secrets add-iam-policy-binding "${secret}" \
    --member="serviceAccount:${CB_DEPLOY_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="${PROJECT_ID}" \
    --quiet >/dev/null
done

echo "============================================================"
echo "SUCCESS: product, developers, apps and credential secrets are in place."
echo "Secrets (not printed): ${SECRET_MOT_KEY}, ${SECRET_MOT_SECRET} (MOT handover, out of band),"
echo "                       ${SECRET_SMOKE_KEY}, ${SECRET_SMOKE_SECRET} (pipeline smoke)"
echo "============================================================"
