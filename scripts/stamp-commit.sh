#!/usr/bin/env bash
# Stamps the commit into the sar-mot-kpis-v1 proxy bundle before it is deployed (as cicd-workspace).
#
#   stamp-commit.sh <short_sha> <build_id> [apiproxy_dir]
#
#   short_sha     7-40 lowercase hex characters (Cloud Build ${SHORT_SHA})
#   build_id      [A-Za-z0-9._-]+ (Cloud Build ${BUILD_ID})
#   apiproxy_dir  default: src/main/apigee/apiproxies/sar-mot-kpis-v1/apiproxy (repo-relative to
#                 this script); the unit tests pass a temp copy.
#
# 1. <Description> in <apiproxy_dir>/sar-mot-kpis-v1.xml becomes, on one line:
#      <Description>sar-mot-kpis-v1 | commit <short_sha> | build <build_id></Description>
# 2. __KVM_VERSION__ is replaced with <short_sha> in <apiproxy_dir>/policies/*.xml. The files
#    holding it must be exactly KVM-GetConfig.xml and KVM-GetErrorMessage.xml; afterwards no
#    placeholder may remain anywhere in the bundle and their mapIdentifier attributes must be
#    sar-mot-kpis-config-<short_sha> / sar-mot-kpis-errors-<short_sha>.
# Idempotent: a re-run with the same short_sha (placeholders already gone, identifiers already
# stamped with it) succeeds; a re-run with a different short_sha after stamping fails.
# Writes: the files above, in place. No network. Exit 0 ok, 1 verification failed, 2 bad arguments.
set -euo pipefail
set +x

usage() {
  echo "usage: $(basename "$0") <short_sha> <build_id> [apiproxy_dir]" >&2
}
if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi
SHA="$1"; BUILD="$2"
if [[ ! "${SHA}" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "ERROR: short_sha must be 7-40 lowercase hex characters." >&2
  exit 2
fi
if [[ ! "${BUILD}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: build_id must match [A-Za-z0-9._-]+." >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="${3:-${ROOT}/src/main/apigee/apiproxies/sar-mot-kpis-v1/apiproxy}"
DESCRIPTOR="${BUNDLE}/sar-mot-kpis-v1.xml"
POLICIES="${BUNDLE}/policies"
EXPECTED="KVM-GetConfig.xml KVM-GetErrorMessage.xml"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ -f "${DESCRIPTOR}" ]] || fail "proxy descriptor not found: ${DESCRIPTOR}"
[[ -d "${POLICIES}" ]] || fail "policies directory not found: ${POLICIES}"

# 1. Description (exactly one element, on one line).
COUNT="$(grep -c '<Description>.*</Description>' "${DESCRIPTOR}" || true)"
[[ "${COUNT}" == "1" ]] || fail "expected exactly one one-line <Description> in ${DESCRIPTOR}, found ${COUNT}"
DESC="sar-mot-kpis-v1 | commit ${SHA} | build ${BUILD}"
sed -i "s#<Description>.*</Description>#<Description>${DESC}</Description>#" "${DESCRIPTOR}"
grep -Fq "<Description>${DESC}</Description>" "${DESCRIPTOR}" || fail "Description was not stamped"

# 2. KVM version placeholder.
FOUND="$(grep -l '__KVM_VERSION__' "${POLICIES}"/*.xml 2>/dev/null | xargs -r -n1 basename | sort | tr '\n' ' ' | sed 's/ $//' || true)"
if [[ -n "${FOUND}" ]]; then
  [[ "${FOUND}" == "${EXPECTED}" ]] || fail "placeholder files are '${FOUND}', expected '${EXPECTED}'"
  for f in ${EXPECTED}; do
    sed -i "s/__KVM_VERSION__/${SHA}/g" "${POLICIES}/${f}"
  done
  STAMPED=2
else
  echo "No __KVM_VERSION__ placeholder left: checking the bundle is already stamped with ${SHA}."
  STAMPED=0
fi
if grep -rqs '__KVM_VERSION__' "${BUNDLE}"; then
  fail "__KVM_VERSION__ still present in: $(grep -rls '__KVM_VERSION__' "${BUNDLE}" | tr '\n' ' ')"
fi
grep -q "mapIdentifier=\"sar-mot-kpis-config-${SHA}\"" "${POLICIES}/KVM-GetConfig.xml" \
  || fail "KVM-GetConfig.xml mapIdentifier is not sar-mot-kpis-config-${SHA}"
grep -q "mapIdentifier=\"sar-mot-kpis-errors-${SHA}\"" "${POLICIES}/KVM-GetErrorMessage.xml" \
  || fail "KVM-GetErrorMessage.xml mapIdentifier is not sar-mot-kpis-errors-${SHA}"

echo "Stamped: Description '${DESC}'; KVM version ${SHA} (${STAMPED} policy files changed)."
