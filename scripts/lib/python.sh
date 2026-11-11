#!/usr/bin/env bash
# Sourced helper: sets PY to the first working Python 3 interpreter.
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"     (from a script in scripts/)
#
# Candidates, in order: python3, python, then the Python bundled with gcloud
# (gcloud info --format='value(basic.python_location)', a local call, no network).
# Each candidate is probed with
#   "$p" -c 'import sys; sys.exit(0 if sys.version_info[0]>=3 else 1)'
# so the Windows Store stub (prints "Python was not found", exits 9009/1) and Python 2 are
# skipped. In Cloud Build images python3 is present, so it is chosen first (unchanged behaviour).
# If none works, prints a clear message on stderr and returns 1 (the caller's set -e stops it).
# Sets only PY (and the loop variable _py_candidate, unset afterwards).

_py_probe() {
  [[ -n "$1" ]] && "$1" -c 'import sys; sys.exit(0 if sys.version_info[0]>=3 else 1)' >/dev/null 2>&1
}

PY=""
for _py_candidate in python3 python; do
  if _py_probe "${_py_candidate}"; then
    PY="${_py_candidate}"
    break
  fi
done
if [[ -z "${PY}" ]] && command -v gcloud >/dev/null 2>&1; then
  _py_candidate="$(gcloud info --format='value(basic.python_location)' 2>/dev/null || true)"
  _py_candidate="${_py_candidate//$'\r'/}"
  if _py_probe "${_py_candidate}"; then
    PY="${_py_candidate}"
  fi
fi
unset _py_candidate
unset -f _py_probe

if [[ -z "${PY}" ]]; then
  echo "ERROR: no working Python 3 found (tried python3, python and gcloud's bundled Python)." >&2
  return 1 2>/dev/null || exit 1
fi
