#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHEEL="$(find "$HERE" -maxdepth 1 -name 'jupyter_notebook_assistant-*.whl' -print -quit)"

if [[ -z "$WHEEL" ]]; then
  echo "No jupyter_notebook_assistant wheel was found in $HERE" >&2
  exit 1
fi

python - <<'PY'
import sys
try:
    import jupyterlab
except Exception as exc:
    raise SystemExit(f"JupyterLab is not importable from {sys.executable}: {exc}")
major = int(jupyterlab.__version__.split('.', 1)[0])
if major != 4:
    raise SystemExit(f"JupyterLab 4.x is required; found {jupyterlab.__version__}")
print(f"Using Python: {sys.executable}")
print(f"JupyterLab: {jupyterlab.__version__}")
PY

python -m pip install --prefix "$HOME/.local" --force-reinstall --no-deps "$WHEEL"

echo
echo "Installed Jupyter Notebook Assistant."
echo "Restart the complete JupyterHub single-user server (stop and start it)."
echo
CODEX_BIN="$(command -v codex 2>/dev/null || true)"
if [[ -z "$CODEX_BIN" && -x "$HOME/.local/bin/codex" ]]; then
  CODEX_BIN="$HOME/.local/bin/codex"
fi
if [[ -n "$CODEX_BIN" ]]; then
  echo "Codex CLI: $($CODEX_BIN --version 2>/dev/null || printf '%s' "$CODEX_BIN")"
else
  echo "Codex CLI was not found. Manual ChatGPT mode will work, but Codex mode needs Codex installed and authenticated."
  echo "Official Linux installer: curl -fsSL https://chatgpt.com/codex/install.sh | sh"
  echo "Remote login: codex login --device-auth"
fi
