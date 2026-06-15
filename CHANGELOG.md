# Changelog

All notable changes to Jupyter Notebook Assistant are documented here.

The project follows semantic versioning where practical during the pre-1.0 development phase.

## [0.1.27] - 2026-06-15

### Added

- Comprehensive public-project README covering both Codex and manual ChatGPT workflows.
- Detailed Agent mode permission semantics, precedence rules, risk analysis, suggested configurations, and disclaimers.
- Codex authentication-recovery instructions for revoked or invalidated credentials.
- README/documentation and AGPL license links in the extension settings menu.
- GitHub publication metadata, CI/release workflows, contributing guide, security policy, citation metadata, and release checklist.
- Complete GNU Affero General Public License v3 text.

### Changed

- Package metadata now points to `HighIander/jupyter-notebook-assistant`.
- Version increased to 0.1.27.

## [0.1.26] - 2026-06-15

### Added

- Cluster compatibility mode for environments where the Codex Linux `bubblewrap` sandbox fails with errors such as `bwrap: pivot_root: Invalid argument`.
- Explicit danger confirmation and persistent banner when Codex runs with `danger-full-access`.
- Improved sandbox failure detection and terminal diagnostics.

## [0.1.25] - 2026-06-15

### Added

- English Agent mode labels and prompts.
- Header login button and first-start login dialog.
- Optional agent policy boundaries with whitelist/blacklist patterns.
- Most-permissive resolution for overlapping Agent path categories.
- Improved project-root resolution through the Jupyter terminal service.

## [0.1.24] - 2026-06-15

### Added

- TerminalManager-based project Agent mode without a custom Jupyter Server extension.
- Project-root, path-scope, file-operation, test, and command permissions.
- Authentication-error replacement instructions.

## Earlier releases

Earlier pre-publication versions developed the notebook patch workflow, context controls, session history, manual ChatGPT workflow, Codex integration, toolbar compatibility, and keyboard shortcuts.
