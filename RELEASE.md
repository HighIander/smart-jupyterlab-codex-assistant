# Release checklist

## 1. Prepare the release

- Confirm the working tree is clean.
- Update versions in `package.json`, `package-lock.json`, `pyproject.toml`, and `jupyter_notebook_assistant/__init__.py`.
- Update `README.md`, `QUICKSTART.txt`, and `CHANGELOG.md`.
- Confirm repository URLs and author metadata.
- Review Agent mode security documentation against the actual implementation.

## 2. Build and verify

```bash
npm ci
npm run build:prod
python -m pip install build
rm -rf dist build
python -m build
python -m pip install --force-reinstall --no-deps dist/*.whl
jupyter labextension list
```

Test both local and Agent workflows in a JupyterLab 4 environment.

## 3. Build the standalone ZIP

For version `X.Y.Z`:

```bash
VERSION=X.Y.Z
STAGE="jupyter-notebook-assistant-${VERSION}"
rm -rf "$STAGE" "${STAGE}.zip"
mkdir "$STAGE"
rsync -a ./ "$STAGE"/ \
    --exclude .git \
    --exclude node_modules \
    --exclude dist \
    --exclude build \
    --exclude "$STAGE" \
    --exclude "${STAGE}.zip" \
    --exclude 'jupyter_notebook_assistant-*.whl'
cp dist/jupyter_notebook_assistant-${VERSION}-py3-none-any.whl "$STAGE"/
zip -r "${STAGE}.zip" "$STAGE"
rm -rf "$STAGE"
```

## 4. Commit and tag

```bash
git add .
git commit -m "Release ${VERSION}"
git tag -a "v${VERSION}" -m "Jupyter Notebook Assistant ${VERSION}"
git push origin main
git push origin "v${VERSION}"
```

The GitHub release workflow runs for tags matching `v*`, builds the wheel/source distribution and installation ZIP, and creates a GitHub Release.

## 5. Verify the published release

- Download the release ZIP from GitHub.
- Install it on a clean JupyterLab 4 environment.
- Confirm the settings-menu README and license links resolve.
- Confirm the wheel version, extension package version, and release tag match.
- Confirm the release contains the complete source required by AGPL-3.0-only.
