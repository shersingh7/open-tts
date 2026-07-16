#!/bin/bash
# macOS Gatekeeper: sign espeak-ng dylibs + patch phonemizer temp-copy loader.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PY="${SCRIPT_DIR}/venv/bin/python3"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

if [[ ! -x "${VENV_PY}" ]]; then
  echo "sign_native_dylibs: no venv python at ${VENV_PY}"
  exit 0
fi

env -u PYTHONPATH "${VENV_PY}" "${SCRIPT_DIR}/darwin_espeak_fix.py"