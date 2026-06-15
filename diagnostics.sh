#!/usr/bin/env bash
set -u

echo "Python: $(command -v python)"
python --version
echo
echo "JupyterLab:"
jupyter lab --version || true
echo
echo "Jupyter paths:"
jupyter --paths || true
echo
echo "Extension registration:"
jupyter labextension list 2>&1 | grep -A3 -B2 -i 'jupyter-notebook-assistant' || echo "Extension not listed."
echo
echo "Python package:"
python -m pip show jupyter-notebook-assistant || true
find "$HOME/.local/lib" -maxdepth 4 \
  \( -name 'jupyter_notebook_assistant' -o -name 'jupyter_notebook_assistant-*.dist-info' \) \
  -print 2>/dev/null || true
echo
echo "Codex:"
CODEX_BIN="$(command -v codex 2>/dev/null || true)"
if [[ -z "$CODEX_BIN" && -x "$HOME/.local/bin/codex" ]]; then
  CODEX_BIN="$HOME/.local/bin/codex"
fi
if [[ -n "$CODEX_BIN" ]]; then
  echo "$CODEX_BIN"
  "$CODEX_BIN" --version || true
  "$CODEX_BIN" login status || true
else
  echo "Codex CLI not found in PATH or at $HOME/.local/bin/codex."
fi
