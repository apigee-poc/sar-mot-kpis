#!/usr/bin/env bash
# Uploads migrations and seeds to GCS, then imports them into Cloud SQL database.
# Usage: load.sh <env> [env_file]
# Examples: load.sh dev
#           load.sh staging
#           load.sh prod infra/env/prod.env
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <dev|staging|prod> [env_file]" >&2
  exit 1
fi

TARGET_ENV="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ "${TARGET_ENV}" == "prod" ]]; then
  ENV_FILE="${2:-${REPO_ROOT}/infra/env/prod.env}"
else
  ENV_FILE="${2:-${REPO_ROOT}/infra/env/nonprod.env}"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${ENV_FILE}"

DATABASE="kpis_${TARGET_ENV}"
echo "============================================================"
echo "Loading schema and seed data into ${DATABASE} on ${SQL_INSTANCE}"
echo "Project: ${PROJECT_ID} | Region: ${REGION}"
echo "============================================================"

# 1. Upload migrations and seeds to GCS
echo "Uploading SQL files to gs://${SEED_BUCKET}..."
gcloud storage cp "${REPO_ROOT}"/db/migrations/*.sql "gs://${SEED_BUCKET}/migrations/" --project="${PROJECT_ID}" --quiet
gcloud storage cp "${REPO_ROOT}"/db/seed/*.sql "gs://${SEED_BUCKET}/seed/" --project="${PROJECT_ID}" --quiet

# 2. Run migrations in order
for MIG_FILE in "${REPO_ROOT}"/db/migrations/*.sql; do
  [ -f "${MIG_FILE}" ] || continue
  BASE_NAME="$(basename "${MIG_FILE}")"
  GCS_URI="gs://${SEED_BUCKET}/migrations/${BASE_NAME}"
  echo "Applying migration ${BASE_NAME} from ${GCS_URI} to ${DATABASE}..."
  gcloud sql import sql "${SQL_INSTANCE}" "${GCS_URI}" \
    --database="${DATABASE}" \
    --project="${PROJECT_ID}" \
    --quiet
done

# 3. Run seeds in order
for SEED_FILE in "${REPO_ROOT}"/db/seed/*.sql; do
  [ -f "${SEED_FILE}" ] || continue
  BASE_NAME="$(basename "${SEED_FILE}")"
  GCS_URI="gs://${SEED_BUCKET}/seed/${BASE_NAME}"
  echo "Applying seed ${BASE_NAME} from ${GCS_URI} to ${DATABASE}..."
  gcloud sql import sql "${SQL_INSTANCE}" "${GCS_URI}" \
    --database="${DATABASE}" \
    --project="${PROJECT_ID}" \
    --quiet
done

echo "SUCCESS: Schema and seeds loaded into ${DATABASE}."
