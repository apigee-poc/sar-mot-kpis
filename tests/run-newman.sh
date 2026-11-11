#!/usr/bin/env bash
# Run the Newman contract suite against a non-prod environment.
#
#   tests/run-newman.sh <dev|staging> [--folder <name>]... [--env-var faultScenario=<fiNN>] [--bail]
#   tests/run-newman.sh dev --folder "Happy paths"
#   tests/run-newman.sh dev --folder "Error rows"
#
# The four test-app credentials are read from Secret Manager in apigee-nonprod-511322 into shell
# variables and passed to newman as --env-var. They are never echoed or written to a file. Note:
# --env-var values are visible in the local process list while newman runs.
# Prod is never run from a workstation (AGENTS.md rule 2); the prod smoke subset is a P8 pipeline
# decision (D47). `local` has no emulator (D39). npm run test:dev / test:staging call this script.
set -euo pipefail
set +x

PROJECT="apigee-nonprod-511322"

usage() {
  echo "usage: $0 <dev|staging> [--folder <name>]... [--env-var faultScenario=<fiNN>] [--bail]" >&2
}

if [ "$#" -lt 1 ]; then
  usage
  exit 2
fi

ENV_NAME="$1"
shift

case "$ENV_NAME" in
  dev|staging) ;;
  prod)
    echo "Refusing to run against prod from a workstation (AGENTS.md rule 2). Prod smoke tests run only in cloudbuild-prod.yaml." >&2
    exit 2
    ;;
  local)
    echo "Refusing 'local': there is no local emulator (D39). Use dev or staging." >&2
    exit 2
    ;;
  *)
    usage
    exit 2
    ;;
esac

# Allowlist of the arguments passed through to newman (checked before any gcloud call). Anything
# else could send the real credentials elsewhere (--env-var baseUrl=..., -e, --global-var) or write
# them to disk (--export-*, --reporters json, --verbose), so it is refused (AGENTS.md rules 2, 4).
#   --folder <name>                    one of KNOWN_FOLDERS (repeatable)
#   --env-var faultScenario=<scenario> only with exactly one matching FI-xx folder, dev only
#   --bail
# Both "--opt value" and "--opt=value" forms are accepted.
KNOWN_FOLDERS=(
  "Happy paths"
  "Error rows"
  "FI-06 SpikeArrest 429"
  "FI-07 Quota 429"
  "FI-13 Integration failure 500"
  "FI-16 Unmapped fault 500"
)
FI_PARENT="Fault injection (needs scratch config)"

refuse() {
  echo "Refusing: $*" >&2
  exit 2
}

is_known_folder() {
  local f
  for f in "${KNOWN_FOLDERS[@]}"; do
    if [ "$f" = "$1" ]; then
      return 0
    fi
  done
  return 1
}

FOLDERS=()
SCENARIO=""
SCENARIO_SET=0
BAIL=0
add_folder() {
  if [ "$1" = "$FI_PARENT" ]; then
    refuse "the parent fault-injection folder; run one FI-xx subfolder at a time."
  fi
  is_known_folder "$1" || refuse "unknown folder '$1' (known: ${KNOWN_FOLDERS[*]})."
  FOLDERS+=("$1")
}
set_env_var() {
  case "$1" in
    faultScenario=*)
      [ "$SCENARIO_SET" = 0 ] || refuse "faultScenario given twice."
      SCENARIO="${1#faultScenario=}"
      SCENARIO_SET=1
      case "$SCENARIO" in
        fi06|fi07|fi13|fi16|fi16b) ;;
        *) refuse "unknown faultScenario '$SCENARIO' (fi06, fi07, fi13, fi16, fi16b)." ;;
      esac
      ;;
    *) refuse "--env-var '${1%%=*}': only faultScenario may be set (credentials and hosts come from the runner)." ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --folder)
      [ "$#" -ge 2 ] || refuse "--folder needs a folder name."
      add_folder "$2"
      shift 2
      ;;
    --folder=*)
      add_folder "${1#--folder=}"
      shift
      ;;
    --env-var)
      [ "$#" -ge 2 ] || refuse "--env-var needs a value."
      set_env_var "$2"
      shift 2
      ;;
    --env-var=*)
      set_env_var "${1#--env-var=}"
      shift
      ;;
    --bail)
      BAIL=1
      shift
      ;;
    -*)
      refuse "argument '${1%%=*}' is not allowed (allowed: --folder <name>, --env-var faultScenario=<scenario>, --bail)."
      ;;
    *)
      # Not echoed: a stray value could be a credential.
      refuse "a non-option argument is not allowed (allowed: --folder <name>, --env-var faultScenario=<scenario>, --bail)."
      ;;
  esac
done

# Fault injection: FI requests are skipped unless faultScenario matches, which would give a green
# run with 0 requests. An FI folder needs its scenario, and a scenario needs exactly one matching
# FI folder (tests/fault-injection/README.md).
FI_FOLDERS=0
for folder in ${FOLDERS[@]+"${FOLDERS[@]}"}; do
  case "$folder" in
    FI-06*) ALLOWED="fi06" ;;
    FI-07*) ALLOWED="fi07" ;;
    FI-13*) ALLOWED="fi13" ;;
    FI-16*) ALLOWED="fi16 fi16b" ;;
    *) continue ;;
  esac
  FI_FOLDERS=$((FI_FOLDERS + 1))
  [ "$ENV_NAME" = "dev" ] || refuse "fault-injection folders run on dev only."
  case " $ALLOWED " in
    *" $SCENARIO "*) ;;
    *) refuse "folder '$folder' needs --env-var faultScenario=<${ALLOWED// /|}> (got '${SCENARIO}')." ;;
  esac
done
if [ "$SCENARIO_SET" = 1 ]; then
  if [ "${#FOLDERS[@]}" -ne 1 ] || [ "$FI_FOLDERS" -ne 1 ]; then
    refuse "faultScenario=${SCENARIO} needs exactly one matching FI-xx folder and no other folder."
  fi
fi

NEWMAN_ARGS=()
for folder in ${FOLDERS[@]+"${FOLDERS[@]}"}; do
  NEWMAN_ARGS+=(--folder "$folder")
done
if [ "$SCENARIO_SET" = 1 ]; then
  NEWMAN_ARGS+=(--env-var "faultScenario=$SCENARIO")
fi
if [ "$BAIL" = 1 ]; then
  NEWMAN_ARGS+=(--bail)
fi

# Test hook (tests/unit/run-newman-args.test.js): stop after validation, before any gcloud call.
if [ "${RUN_NEWMAN_VALIDATE_ONLY:-}" = "1" ]; then
  printf 'VALID env=%s' "$ENV_NAME"
  for a in ${NEWMAN_ARGS[@]+"${NEWMAN_ARGS[@]}"}; do
    printf ' [%s]' "$a"
  done
  printf '
'
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COLLECTION="tests/sar-mot-kpis.postman_collection.json"
ENV_FILE="tests/environments/${ENV_NAME}.postman_environment.json"
REPORT="reports/newman-${ENV_NAME}${SCENARIO:+-${SCENARIO}}.xml"

# With gcloud (workstation): gcloud secrets versions access. Without gcloud (Cloud Build node
# image, P7): the Secret Manager REST API with the build token in /workspace/.token, decoded by
# node. Either way the value only reaches the caller's variable; it is never echoed or written.
read_secret() {
  if command -v gcloud >/dev/null 2>&1; then
    gcloud secrets versions access latest --secret="$1" --project="$PROJECT" --quiet
    return
  fi
  local token
  token="$(tr -d '\r\n[:space:]' < /workspace/.token 2>/dev/null || true)"
  if [ -z "$token" ]; then
    echo "ERROR: no gcloud and no /workspace/.token: cannot read secret $1" >&2
    return 1
  fi
  curl -sS --fail -H "Authorization: Bearer $token" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$1/versions/latest:access" \
    | node -e '
let s = "";
process.stdin.on("data", (c) => { s += c; });
process.stdin.on("end", () => {
  let d;
  try { d = JSON.parse(s).payload.data; } catch (e) { d = undefined; }
  if (typeof d !== "string" || d === "") {
    process.stderr.write("ERROR: unexpected Secret Manager response\n");
    process.exit(1);
  }
  process.stdout.write(Buffer.from(d, "base64").toString("utf8"));
});'
}

# Plain assignments (not `local x=$(...)`) so a failing gcloud stops the script (set -e).
API_KEY="$(read_secret sar-mot-poc-app-api-key)"
API_SECRET="$(read_secret sar-mot-poc-app-api-secret)"
OTHER_API_KEY="$(read_secret sar-mot-poc-other-app-api-key)"
OTHER_API_SECRET="$(read_secret sar-mot-poc-other-app-api-secret)"

mkdir -p reports

npx --no-install newman run "$COLLECTION" \
  -e "$ENV_FILE" \
  --env-var "apiKey=$API_KEY" \
  --env-var "apiSecret=$API_SECRET" \
  --env-var "otherApiKey=$OTHER_API_KEY" \
  --env-var "otherApiSecret=$OTHER_API_SECRET" \
  --reporters cli,junit \
  --reporter-junit-export "$REPORT" \
  ${NEWMAN_ARGS[@]+"${NEWMAN_ARGS[@]}"}
