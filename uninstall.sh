#!/usr/bin/env bash
set -euo pipefail

# A managed JupyterHub virtual environment may not expose user site-packages,
# so remove the user-local extension data directly as well as trying pip.
python -m pip uninstall -y jupyter-notebook-assistant >/dev/null 2>&1 || true
rm -rf "$HOME/.local/share/jupyter/labextensions/jupyter-notebook-assistant"
find "$HOME/.local/lib" -maxdepth 4 \
  \( -name 'jupyter_notebook_assistant' -o -name 'jupyter_notebook_assistant-*.dist-info' \) \
  -exec rm -rf {} + 2>/dev/null || true

echo "Uninstalled. Restart the complete JupyterHub single-user server."
