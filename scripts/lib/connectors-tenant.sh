#!/usr/bin/env bash
# Sourced helper (P8): resolves the Integration Connectors runtime tenant project of a project and
# region at run time (D18/D19: the tenant is only known after Application Integration /
# Connectors are provisioned, so it is never committed for prod).
#
#   source ".../scripts/lib/connectors-tenant.sh"
#   TENANT="$(resolve_connectors_tenant <project> <region> <token>)" || exit 1
#
# Calls GET https://connectors.googleapis.com/v1/projects/<project>/locations/<region>/runtimeConfig
# and reads its "serviceDirectory" field. The REST reference documents the field only as "the name
# of the Service Directory service name"; its format is taken from the non-prod connector task
# config (D19: projects/<tenant>-tp/locations/us-central1/namespaces/connectors/services/runtime)
# and is VERIFY on the first prod run. The WHOLE value must match
#   ^projects/<tenant>/locations/<region>/namespaces/connectors/services/runtime$
# so the rest of the committed serviceName template is validated as well.
# Fails closed (non-zero, message on stderr, nothing on stdout) on: empty token, network error,
# HTTP status other than 200, missing field, a value of another shape, or the non-prod tenant
# (CONNECTORS_NONPROD_TENANT) returned for a project that is not the non-prod project.
# Needs: curl, grep, sed (no node/Python, so it runs in both cloud-sdk:slim and node:22).
# The token is never printed.

CONNECTORS_NONPROD_TENANT="ef911070c468726ff-tp"

resolve_connectors_tenant() {
  local project="$1" region="$2" token="$3" work code value tenant
  if [[ -z "${project}" || -z "${region}" ]]; then
    echo "ERROR: resolve_connectors_tenant needs <project> <region> <token>." >&2
    return 1
  fi
  if [[ -z "${token}" ]]; then
    echo "ERROR: empty access token; cannot read the Connectors runtimeConfig." >&2
    return 1
  fi
  work="$(mktemp -d)"
  : > "${work}/rc.json"
  if ! code="$(curl -sS -o "${work}/rc.json" -w '%{http_code}' -H "Authorization: Bearer ${token}" \
      "https://connectors.googleapis.com/v1/projects/${project}/locations/${region}/runtimeConfig" \
      2>"${work}/curl.err")"; then
    echo "ERROR: network error reading the Connectors runtimeConfig of ${project}/${region}: $(head -c 300 "${work}/curl.err")" >&2
    rm -rf "${work}"
    return 1
  fi
  if [[ "${code}" != "200" ]]; then
    echo "ERROR: reading the Connectors runtimeConfig of ${project}/${region} failed with HTTP ${code}: $(head -c 500 "${work}/rc.json")" >&2
    rm -rf "${work}"
    return 1
  fi
  value="$(tr -d '\r\n' < "${work}/rc.json" | grep -o '"serviceDirectory"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 \
    | sed 's/^"serviceDirectory"[[:space:]]*:[[:space:]]*"\(.*\)"$/\1/' || true)"
  rm -rf "${work}"
  if [[ -z "${value}" ]]; then
    echo "ERROR: the Connectors runtimeConfig of ${project}/${region} has no serviceDirectory (Connectors not provisioned yet?)." >&2
    return 1
  fi
  local re="^projects/([a-z0-9][a-z0-9-]{3,61}[a-z0-9])/locations/${region}/namespaces/connectors/services/runtime$"
  if [[ ! "${value}" =~ ${re} ]]; then
    echo "ERROR: unexpected serviceDirectory '${value}' (expected projects/<tenant>/locations/${region}/namespaces/connectors/services/runtime)." >&2
    return 1
  fi
  tenant="${BASH_REMATCH[1]}"
  if [[ "${tenant}" == "${CONNECTORS_NONPROD_TENANT}" && "${project}" != "apigee-nonprod-511322" ]]; then
    echo "ERROR: ${project} resolved to the non-prod Connectors tenant ${CONNECTORS_NONPROD_TENANT}; refusing." >&2
    return 1
  fi
  printf '%s\n' "${tenant}"
}
