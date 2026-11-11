#!/usr/bin/env bash
# Run the Newman contract suite against a non-prod environment.
#
#   tests/run-newman.sh <dev|staging> [newman args...]
#   tests/run-newman.sh dev --folder "Happy paths"
#   tests/run-newman.sh dev --folder "Error rows"
#
# The four test-app credentials are read from Secret Manager in apigee-nonprod-511322 into shell
# variables and passed to newman as --env-var. They are never echoed or written to a file. Note:
# --env-var values are visible in the local process list while newman runs.
# Prod is never run from a workstation (AGENTS.md rule 2): the prod smoke subset ("Happy paths")
# runs only from cloudbuild-prod.yaml. `local` has no emulator (D39).
set -euo pipefail
set +x

PROJECT="apigee-nonprod-511322"

usage() {
  echo "usage: $0 <dev|staging> [newman args...]" >&2
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

for arg in "$@"; do
  case "$arg" in
    --verbose|-v)
      echo "Refusing --verbose: it prints request headers, including X-API-Secret." >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COLLECTION="tests/sar-mot-kpis.postman_collection.json"
ENV_FILE="tests/environments/${ENV_NAME}.postman_environment.json"
REPORT="reports/newman-${ENV_NAME}.xml"

read_secret() {
  gcloud secrets versions access latest --secret="$1" --project="$PROJECT" --quiet
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
  "$@"
