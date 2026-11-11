#!/usr/bin/env bash
# Installs a pinned integrationcli (GoogleCloudPlatform/application-integration-management-toolkit)
# for Linux x86_64 (Cloud Build), with SHA-256 verification.
#
#   install-integrationcli.sh [version] [dest]
#
#   version  default 0.86.0 (D20-D23 were verified against it). Format N.N.N.
#   dest     default /workspace/bin. Receives the binary <dest>/integrationcli.
#
# Env: INTEGRATIONCLI_SHA256 - required for any version other than the pinned ones below.
# Release asset: https://github.com/GoogleCloudPlatform/application-integration-management-toolkit/
#   releases/download/v<version>/integrationcli_Linux_x86_64.zip
#   The zip holds integrationcli_Linux_x86_64/integrationcli (plus LICENSE.txt), as in the
#   repo's downloadLatest.sh.
# Verification: the zip's SHA-256 must equal BOTH the pinned constant and its line in the
#   release's checksums.txt. The cosign .sig files of the release are NOT verified.
#   Pinned 0.86.0 digest 52fd27ff...367f was read from the release page (asset digest) and
#   from checksums.txt on 2026-11-12; both agree.
# Needs: curl, sha256sum, and unzip or a Python 3 (zipfile fallback).
# Output: the version line of the installed binary. Exit 0 ok, 1 failure, 2 bad arguments/pin.
set -euo pipefail
set +x

VERSION="${1:-0.86.0}"
DEST="${2:-/workspace/bin}"
if [[ $# -gt 2 ]]; then
  echo "usage: $(basename "$0") [version=0.86.0] [dest=/workspace/bin]" >&2
  exit 2
fi
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: version must look like 0.86.0 (got '${VERSION}')." >&2
  exit 2
fi

case "${VERSION}" in
  0.86.0) PINNED="52fd27ff2c1ef5c2b5bb62613be84628991d0c12d7a0c532bab015b7f0d6367f" ;;
  *)      PINNED="${INTEGRATIONCLI_SHA256:-}" ;;
esac
if [[ ! "${PINNED}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: no pinned SHA-256 for integrationcli ${VERSION}; set INTEGRATIONCLI_SHA256 (64 hex chars)." >&2
  exit 2
fi

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "ERROR: this installer is for Linux x86_64 (Cloud Build) only; got $(uname -s) $(uname -m)." >&2
  exit 1
fi

ASSET="integrationcli_Linux_x86_64"
URL="https://github.com/GoogleCloudPlatform/application-integration-management-toolkit/releases/download/v${VERSION}"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "Downloading integrationcli ${VERSION} (${ASSET}.zip)..."
curl -fsSL --retry 3 -o "${WORK}/${ASSET}.zip" "${URL}/${ASSET}.zip"
curl -fsSL --retry 3 -o "${WORK}/checksums.txt" "${URL}/checksums.txt"

ACTUAL="$(sha256sum "${WORK}/${ASSET}.zip" | awk '{print $1}')"
LISTED="$(awk -v f="${ASSET}.zip" '$2 == f {print $1}' "${WORK}/checksums.txt")"
if [[ "${ACTUAL}" != "${PINNED}" ]]; then
  echo "ERROR: SHA-256 mismatch for ${ASSET}.zip: got ${ACTUAL}, pinned ${PINNED}." >&2
  exit 1
fi
if [[ "${LISTED}" != "${PINNED}" ]]; then
  echo "ERROR: checksums.txt lists '${LISTED:-nothing}' for ${ASSET}.zip, pinned ${PINNED}." >&2
  exit 1
fi
echo "SHA-256 verified: ${ACTUAL}"

mkdir -p "${WORK}/x"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "${WORK}/${ASSET}.zip" -d "${WORK}/x"
else
  # PY = first working Python 3 (scripts/lib/python.sh)
  source "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"
  "${PY}" -m zipfile -e "${WORK}/${ASSET}.zip" "${WORK}/x"
fi
BIN="${WORK}/x/${ASSET}/integrationcli"
if [[ ! -f "${BIN}" ]]; then
  BIN="$(find "${WORK}/x" -type f -name integrationcli | head -n 1)"
fi
if [[ -z "${BIN}" || ! -f "${BIN}" ]]; then
  echo "ERROR: integrationcli binary not found in ${ASSET}.zip." >&2
  exit 1
fi

mkdir -p "${DEST}"
cp "${BIN}" "${DEST}/integrationcli"
chmod +x "${DEST}/integrationcli"

# VERIFY: the version command form; DEPLOYMENT.md records the output
# "integrationcli version 0.86.0 date: ... [commit: ...]". Not fatal: the digest is the check.
OUT="$("${DEST}/integrationcli" --version 2>&1 || "${DEST}/integrationcli" version 2>&1 || true)"
echo "Installed ${DEST}/integrationcli: ${OUT:-<no version output>}"
if [[ "${OUT}" != *"${VERSION}"* ]]; then
  echo "WARNING: version output does not mention ${VERSION} (digest verified, so the binary is the pinned one)." >&2
fi
