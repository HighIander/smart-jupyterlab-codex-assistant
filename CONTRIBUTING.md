# Contributing

Contributions are welcome under the GNU Affero General Public License v3.0 only.

## Before contributing

- Open an issue for substantial behavior, security, permission-model, or UI changes.
- Never include credentials, authentication files, private notebooks, experiment data, or institutional configuration in issues or commits.
- Keep Agent mode defaults conservative.
- Do not weaken sandbox warnings or represent prompt-level policy as a hard operating-system security boundary.

## Development environment

Requirements:

- Python 3.9 or newer;
- Node.js compatible with the JupyterLab 4 extension toolchain;
- JupyterLab 4.x;
- npm.

Install and build:

```bash
npm ci
npm run build:prod
python -m pip install -e .
jupyter labextension develop --overwrite .
```

## Coding conventions

- Use TypeScript for frontend logic.
- Keep the extension frontend-only unless a server-side component is discussed and approved explicitly.
- Prefer standard JupyterLab services and Lumino/JupyterLab UI components.
- Add comments for non-obvious security, transport, notebook-model, and sandbox behavior.
- Preserve user data by default; destructive features require explicit permission and visible warnings.
- Ensure user-facing text is in English.

## Testing changes

At minimum run:

```bash
npm run build:prod
python -m pip install build
python -m build
```

Then test in JupyterLab 4:

- extension activation and robot toolbar button;
- Codex local patch generation and cancellation;
- manual ChatGPT copy/paste/parse workflow;
- notebook permission enforcement;
- Agent mode with read-only and workspace-write settings;
- Agent warning banners and compatibility-mode confirmation;
- settings persistence after a full server restart;
- session history, undo, inverse replay, and delayed patch application.

## Pull requests

- Use a focused branch.
- Keep unrelated formatting changes out of the pull request.
- Update README, CHANGELOG, and version metadata for user-visible changes.
- Describe security implications and test coverage in the pull request body.
- Do not commit `node_modules`, local build environments, authentication files, or private notebooks.

## License of contributions

By submitting a contribution, you agree that it is licensed under the project's AGPL-3.0-only license and that you have the right to submit it under those terms.
