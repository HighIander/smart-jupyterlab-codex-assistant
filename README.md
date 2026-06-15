# Jupyter Notebook Assistant

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![JupyterLab](https://img.shields.io/badge/JupyterLab-4.x-orange.svg)](https://jupyterlab.readthedocs.io/)

A frontend-only JupyterLab 4 extension for controlled AI-assisted notebook editing, manual ChatGPT workflows, and an optional project-wide Codex agent mode.

The extension is designed for remote JupyterLab and JupyterHub environments. It does not require an OpenAI API key and does not install a custom Jupyter Server extension. Local notebook operations use a helper kernel; project-wide agent operations use JupyterLab's existing terminal service (`TerminalManager`).

> **Important:** Agent mode can read, modify, create, delete, or execute files and commands with the permissions of your JupyterHub account. Review the entire [Security and disclaimers](#security-and-disclaimers) section before enabling it.

## Project information

- **Author:** Thomas Kluge
- **GitHub:** [@HighIander](https://github.com/HighIander)
- **Repository:** [HighIander/jupyter-notebook-assistant](https://github.com/HighIander/jupyter-notebook-assistant)
- **License:** GNU Affero General Public License v3.0 only (`AGPL-3.0-only`)
- **Supported host:** JupyterLab 4.x
- **Status:** Experimental research/developer tooling; review all generated changes before relying on them

This project is independent and is not an official OpenAI, ChatGPT, Codex, Project Jupyter, or JupyterLab product.

## Contents

- [Core capabilities](#core-capabilities)
- [Installation](#installation)
- [Codex installation and login](#codex-installation-and-login)
- [Main window](#main-window)
- [Codex workflow](#codex-workflow)
- [Manual ChatGPT workflow](#manual-chatgpt-workflow)
- [Notebook permissions](#notebook-permissions)
- [Agent mode](#agent-mode)
- [Agent permission precedence](#agent-permission-precedence)
- [Agent security risks](#agent-security-risks)
- [Suggested configurations](#suggested-configurations)
- [Authentication recovery](#authentication-recovery)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Session history and patch recovery](#session-history-and-patch-recovery)
- [Development and testing](#development-and-testing)
- [Publishing on GitHub](#publishing-on-github)
- [Security and disclaimers](#security-and-disclaimers)
- [License](#license)

## Core capabilities

### Local notebook editing

- Collects selected notebook context, including cell sources, outputs, execution counts, hashes, active/selected state, and optional nearby cells.
- Requests a schema-constrained notebook patch from Codex or parses a patch copied from ChatGPT.
- Validates patch structure, cell IDs, allowed operation types, edit scope, and Python syntax before modifying the notebook.
- Shows a conventional colored diff before applying changes.
- Supports replace, insert, append, delete, and move operations according to the configured notebook permissions.
- Can automatically apply a generated patch and optionally run selected cells afterward.
- Keeps session history with patch replay, inverse replay, and full notebook snapshot restoration for recent entries.

### Project-wide agent editing

- Starts `codex exec` in a dedicated hidden Jupyter terminal.
- Resolves the configured project root through the actual terminal working directory.
- Allows Codex to inspect local imports and dependency chains, modify project files, create or delete files, and run tests or commands when explicitly permitted.
- Supports Codex `read-only`, `workspace-write`, and an optional `danger-full-access` compatibility mode for restricted clusters where the Linux sandbox cannot start.
- Displays the final agent summary, Codex thread ID, exact sandbox mode, resolved project path, and failed command events.

### No custom server extension

The extension communicates only through standard JupyterLab services:

- notebook models and commands;
- kernel/session services for local notebook patches;
- `TerminalManager` for agent mode;
- browser local storage for extension settings.

## Requirements

- JupyterLab 4.x.
- A Python kernelspec available to the Jupyter server.
- For Codex workflow and Agent mode: Codex CLI installed on the remote JupyterHub account and authenticated with a ChatGPT account that has Codex access.
- For manual ChatGPT workflow: access to ChatGPT in the browser. Codex CLI is not required.

## Installation

Download the release archive and run:

```bash
unzip jupyter-notebook-assistant-0.1.27.zip
cd jupyter-notebook-assistant-0.1.27
bash install.sh
```

Then restart the complete JupyterHub single-user server:

1. Open **File → Hub Control Panel**.
2. Stop the server.
3. Start the server again.
4. Perform a hard browser reload.

Open a notebook and click the robot icon in the notebook toolbar, or run **Open Jupyter Assistant** from the JupyterLab command palette.

### Updating an existing installation

Install the new wheel with the same `install.sh` procedure. A full single-user-server restart is required because the prebuilt frontend bundle is loaded when JupyterLab starts.

### Uninstalling

```bash
bash uninstall.sh
```

Restart the complete JupyterHub single-user server afterward.

## Codex installation and login

Install Codex CLI on the remote host when necessary:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Ensure that the local binary directory is available:

```bash
export PATH="$HOME/.local/bin:$PATH"
hash -r
```

For persistent file-based credentials, create or edit `~/.codex/config.toml`:

```toml
cli_auth_credentials_store = "file"
```

Then authenticate:

```bash
codex login --device-auth
codex login status
codex --version
```

The extension also checks `$HOME/.local/bin/codex` directly when that directory is missing from the helper environment's `PATH`.

The **Log in** button at the top right displays copyable login commands. The login dialog is also shown once when the extension is opened for the first time.

`codex exec --ephemeral` prevents Codex rollout/session files from being retained for that run. It does **not** make authentication ephemeral and does not remove `~/.codex/auth.json`.

## Main window

### Header

- **Log in:** opens the Codex authentication instructions.
- **Settings (gear):** opens persistent extension settings:
  - input key behavior;
  - persistent user instructions;
  - README/documentation link;
  - AGPL license link;
  - stored undo-snapshot limit.
- **Agent mode banner:** a sticky red banner appears whenever Agent mode is active. When cluster compatibility mode is enabled, it explicitly states that the Codex OS sandbox is disabled.

### Mode selector

- **Codex workflow:** submits the task directly to Codex CLI.
- **ChatGPT manual:** creates a prompt for manual transfer to ChatGPT and parses the pasted response.

Agent mode is available only within the Codex workflow. Switching to manual ChatGPT automatically returns the working mode to local notebook mode.

### Task area

- **Task:** describes the requested change, analysis, or project operation.
- **New conversation:** clears the current task/result state and starts a new local conversation counter.
- **Reasoning effort:** Low, Medium, High, or Extra high for Codex.
- **Mode:** Normal or Fast Codex service tier.
- **Notebook permissions:** configures notebook context and allowed notebook patch operations.
- **Agent mode:** opens project-agent permissions; the adjacent switch activates/deactivates Agent mode.

### Conversation/result area

Depending on the workflow, this area shows:

- generated or parsed patch summary;
- operation checkboxes;
- per-cell source previews and human-readable cell positions;
- conventional red/green diff;
- validation errors;
- agent final response and terminal diagnostics;
- apply, reject, undo, history, and optional run controls.

## Codex workflow

The Codex workflow has two working modes.

### Local notebook mode

Local mode is the default and safest workflow.

1. Enter a task.
2. Configure **Notebook permissions**.
3. Select **Generate patch**.
4. Review the summary, operations, and diff.
5. Select or deselect individual operations.
6. Apply the patch, or reject it.
7. Optionally run selected cells after application.

The extension sends notebook context to Codex through a hidden helper kernel, but Codex never directly edits the notebook file. Codex must return a JSON patch matching a fixed schema. The browser validates the patch and applies only approved operations.

#### Local Codex controls

- **Generate patch:** requests a new notebook patch.
- **Cancel:** interrupts an active Codex request.
- **Automatically apply after patch generation:** applies a valid patch immediately. Use only when the notebook permission scope is narrow and the task is low risk.
- **Automatically run selected cell(s) on apply:** executes selected notebook cells after patch application. This can run arbitrary code already present or generated in those cells.
- **Reject:** discards the currently displayed patch without modifying the notebook.
- **Apply:** applies checked operations after validation.

#### Advantages

- No copy/paste step.
- Structured, schema-constrained output.
- Browser-side permission checks and Python syntax validation.
- Exact cell IDs and stale-context checks reduce accidental edits to the wrong cell.
- Full diff and session history are integrated.

#### Limitations

- Requires Codex CLI and valid authentication on the remote host.
- Codex context is limited to the notebook data selected in **Notebook permissions**.
- Local mode cannot inspect arbitrary imported files unless their content is already present in the notebook context.

### Agent mode within Codex workflow

When Agent mode is active, **Generate patch** becomes **Run agent**. Codex operates in the configured project directory and can directly inspect or edit project files. Notebook patch action buttons are hidden because the agent changes files during the run rather than returning a notebook-only patch.

Use Agent mode for dependency inspection, imported-module repair, multi-file refactoring, or test-driven project changes. Use local mode for ordinary cell edits.

## Manual ChatGPT workflow

The manual workflow never starts Codex CLI and never automates or reads the ChatGPT webpage.

1. Enter a task.
2. Configure **Notebook permissions**.
3. Select **Open ChatGPT** to generate/copy the prompt and open ChatGPT in a new browser tab, or select **Copy prompt** only.
4. Paste the prompt into ChatGPT and submit it.
5. Copy ChatGPT's answer.
6. Paste the answer into the extension response field.
7. Select **Parse pasted response**.
8. Review and apply the resulting patch.

#### Manual workflow controls

- **Open ChatGPT:** copies the generated prompt and opens ChatGPT.
- **Copy prompt:** copies the generated prompt without opening a new tab.
- **Automatically parse after paste:** parses immediately after content is pasted.
- **Automatically apply after parse:** applies a valid parsed patch immediately.
- **Parse pasted response:** validates the pasted answer and extracts the patch.
- **Ctrl+C in the empty-selection task field:** invokes **Copy prompt** in manual mode.

#### Advantages

- No Codex CLI installation or remote authentication required.
- The user explicitly controls what is transferred to and from ChatGPT.
- Useful when continuing a broader ChatGPT conversation with context that is not available to the remote Codex CLI.
- Works even where terminal services or Codex execution are disabled.

#### Limitations

- Requires manual copy/paste.
- The pasted response can contain malformed JSON or unsupported prose. The parser repairs several common quoting/escape mistakes, but not every malformed answer.
- The extension cannot verify what happened in the external ChatGPT tab.
- Manual mode cannot use project-wide Agent mode.

## Notebook permissions

**Notebook permissions** controls both the context supplied to the model and the operations that a notebook patch may perform.

### Context options

The dialog can include:

- selected cells;
- cells before the active selection;
- cells after the active selection;
- output text;
- Markdown context;
- a configurable maximum amount of text output.

Use **Inspect supplied context** to review exactly what will be included before sending a task.

### Allowed changes

- **Active cell only:** patch operations may target only the active cell.
- **All selected cells:** patch operations may target cells in the current selection.
- **Any cell; may add new cells:** patch operations may target any notebook cell and may insert or append cells.
- **Allow Markdown changes:** permits creating or replacing Markdown cells.
- **Allow delete/move operations:** permits deleting or moving notebook cells.

These restrictions are enforced by the extension when applying notebook patches. They do not define Agent-mode filesystem access.

## Agent mode

Agent mode starts a dedicated Jupyter terminal through `TerminalManager`, runs `codex exec`, and gives Codex a project task plus the current notebook context and configured access policy.

Activation always displays a destructive-operation warning. A sticky red banner remains visible while Agent mode is active.

### Working mode

- **Local:** uses notebook patch permissions and never directly edits project files.
- **Agent mode:** allows direct terminal-based inspection and file operations according to the Agent mode settings.

### Project root

Default: `./`

Relative paths are resolved relative to the current notebook directory by the Jupyter terminal service. The extension reads the terminal's actual filesystem working directory and passes that resolved path to Codex using `--cd`.

Security considerations:

- A narrow project root reduces accidental discovery and modification of unrelated files.
- An absolute path may point outside the notebook tree and should be used only when necessary.
- A project root containing credentials, private datasets, mount points, symlinks, or unrelated projects increases risk.
- Project root is the main Codex workspace for `workspace-write`; it is not, by itself, a complete hard read-deny boundary for every accessible host file.

### Path access categories

Each category has **No access**, **Read**, or **Write**.

#### Notebook directory

The directory containing the current notebook, excluding the special subdirectory category below.

Typical use: inspect or edit a local module such as `printWarning.py` beside the notebook.

Risks:

- **Read** can expose source code, configuration, secrets, and data in that directory to Codex.
- **Write** can corrupt or replace files beside the notebook.

#### Notebook subdirectories

Directories below the notebook directory.

Typical use: inspect a local package such as `analysis/`, `src/`, or `helpers/` imported by the notebook.

Risks:

- The scope may contain large data trees, generated output, or nested repositories.
- Write access can affect many files recursively.

#### Project files referenced in the current notebook

Files conceptually referenced or imported directly by notebook cells.

Typical use: allow `from package.module import function` to lead Codex to `package/module.py`.

Important implementation detail: this is a mandatory policy category supplied to Codex. The extension does not precompute and enforce a complete Python dependency graph. Dynamic imports, modified `sys.path`, runtime-generated paths, symbolic links, and non-Python references may be ambiguous.

#### Project files referenced in references

Files referenced transitively by directly referenced files.

Typical use: inspect a helper imported by an imported module.

Risk: dependency chains can expand substantially and may reach configuration, plugins, tests, or vendor code that was not obvious from the notebook.

#### All in parent up to N levels up

Grants access to files in parent directories above the configured project root, up to the selected number of levels.

This is the broadest path setting and should normally remain **No access**.

Examples:

- `N = 1` may expose the directory containing several sibling projects.
- Larger values can expose substantial parts of a home, shared project, or mounted filesystem tree.

### Add files

Allows creation of new files, but only where the path policy also grants write access.

Risks include:

- unexpected files, caches, notebooks, scripts, or configuration;
- disk consumption;
- creation of startup hooks, package metadata, or executable scripts;
- accidental shadowing of existing imports.

Suggested default: disabled. Enable only for tasks that explicitly require a new module, test, configuration file, or documentation file.

### Delete files

Allows file deletion, but only where the path policy also grants write access.

This is destructive and may be irreversible outside version control or backups. Rename operations are treated as deletion plus creation by the policy.

Suggested default: disabled. Enable only for a narrowly defined cleanup task in a clean Git working tree.

### Run tests

Allows test runners or relevant verification commands after changes.

Risks:

- tests are executable code and may modify files, databases, devices, queues, cluster jobs, or network services;
- repository test hooks can execute arbitrary commands;
- expensive integration tests can consume significant CPU, GPU, memory, storage, or allocation time.

Suggested default: disabled for unfamiliar repositories; enabled for trusted projects with targeted test instructions.

### Run arbitrary terminal commands

Allows general terminal commands. The agent is instructed to use the least destructive command required.

This is a high-risk permission. Commands can:

- remove or overwrite data;
- install or execute software;
- submit or cancel cluster jobs;
- modify Git state;
- read credentials or environment variables;
- start network connections if the environment and Codex configuration permit them;
- consume large compute or storage resources.

Suggested default: disabled. Ordinary source inspection uses minimal read-only discovery commands without this permission. Enable only for a trusted project and a task that genuinely requires general commands.

### Enable agent policy boundaries

Controls filename/directory whitelist or blacklist patterns. Patterns are supplied as mandatory agent instructions and are applied after path-category access is resolved.

Examples:

```text
*.py
*.ipynb
pyproject.toml
./tests/*
./imgs/*
```

Important limitations:

- Patterns are interpreted by the agent as policy, not compiled into an independent operating-system ACL.
- Pattern matching can be ambiguous for absolute paths, symbolic links, case sensitivity, nested paths, or unusual filenames.
- Use the narrowest practical patterns and verify the agent's reported file list.

#### Whitelist

Only matching files or directories are permitted after path grants are resolved. Unmatched paths are forbidden.

Whitelist is safer for narrowly scoped work because new or unexpected filenames remain excluded.

Risk: incomplete patterns can prevent legitimate dependency inspection or tests.

#### Blacklist

Matching files or directories are forbidden; unmatched paths remain allowed if a path category grants access.

Blacklist is easier for broad projects but less safe. It can miss alternate names, hidden files, generated copies, symlink targets, different extensions, or newly introduced sensitive paths.

Suggested default: whitelist.

### Cluster compatibility mode: disable the Codex OS sandbox

Enable this only when terminal diagnostics show a Linux sandbox error such as:

```text
bwrap: pivot_root: Invalid argument
```

Some restricted HPC, JupyterHub, container, or nested-container environments block the namespace, mount, `bubblewrap`, or seccomp operations required by the Codex Linux sandbox.

When compatibility mode is enabled, Codex runs with:

```text
--sandbox danger-full-access
```

Consequences:

- Codex commands have the same filesystem and command access as the JupyterHub user.
- Project-root, path-category, and white/blacklist settings become model instructions only.
- There is no Codex operating-system sandbox to enforce write boundaries.
- The extension uses approval policy `never`, so no per-command confirmation is requested.
- A malicious or mistaken command can access or destroy any data available to the account.

Use this mode only when all of the following are true:

- the cluster's outer environment is trusted and provides acceptable isolation;
- the repository and imported code are trusted;
- the working tree is clean and backed up;
- project root and policy settings are narrow;
- delete and arbitrary-command permissions are disabled unless essential;
- you monitor the task and review diagnostics immediately afterward.

## Agent permission precedence

The following rules describe how settings interact.

### 1. Working mode dominates

- In **Local** working mode, Agent mode permissions are ignored. Notebook permissions govern patch application.
- In **Agent mode**, project access settings govern the instructions and sandbox selection. Notebook context settings still determine what notebook content is sent initially.
- Manual ChatGPT mode always uses Local working mode.

### 2. Overlapping path categories use the most permissive grant

For a path matching several categories:

```text
No access < Read < Write
```

The highest matching permission wins.

Example:

```text
Notebook directory: Read
Project files referenced in current notebook: No access
```

A directly imported `printWarning.py` in the notebook directory remains readable because the notebook-directory grant is more permissive. **No access is not a veto against another matching Read or Write grant.**

A path that matches no Read or Write category is forbidden by the agent policy.

### 3. Whitelist/blacklist narrows access after path grants

When policy boundaries are enabled:

- whitelist: unmatched paths become forbidden;
- blacklist: matching paths become forbidden.

Patterns cannot elevate **No access** to Read or Write. They only narrow a path grant.

### 4. Add/Delete require Write plus their checkbox

- Creating a file requires a matching **Write** path grant, a permitted pattern, and **Add files** enabled.
- Deleting or renaming a file requires a matching **Write** path grant, a permitted pattern, and **Delete files** enabled.

### 5. Test and command permissions are independent

- **Run tests** permits tests even when arbitrary commands are disabled.
- **Run arbitrary terminal commands** permits general commands, but the agent is still instructed not to run tests when **Run tests** is disabled.
- Minimal read-only discovery commands may be used for permitted source inspection even when arbitrary commands are disabled.

### 6. Sandbox selection is automatic

When compatibility mode is disabled:

- only read grants, with no add/delete permission → `read-only`;
- any write grant, Add files, or Delete files → `workspace-write`;
- additional explicitly writable directories may be passed with `--add-dir`.

When compatibility mode is enabled:

- `danger-full-access` overrides the Codex OS sandbox.

The OS sandbox is a technical enforcement layer for command execution, especially write locations. Detailed path categories and filename patterns are additional model instructions. They are not equivalent to a separate filesystem ACL.

### 7. Host account permissions always apply

Codex cannot exceed the Unix permissions, mounts, quotas, scheduler permissions, or other capabilities of the JupyterHub account. Conversely, in `danger-full-access`, anything accessible to that account may be accessible to Codex.

## Agent security risks

| Setting | Primary risk | Suggested default |
|---|---|---|
| Project root | Broad workspace exposes unrelated files | Narrow repository/notebook directory |
| Notebook directory Read | Source/data may be sent to Codex | Enable only when needed |
| Notebook directory Write | Local modules can be overwritten | Off for inspection; on for targeted fixes |
| Subdirectories Read/Write | Recursive scope can become large | No access or Read |
| Referenced files Read | Imported code/config can be disclosed | Read for dependency inspection |
| Referenced files Write | Dependency chain can modify several modules | Enable only for explicit repair/refactor |
| Parent access | Can expose sibling projects or home/shared trees | No access |
| Add files | Unexpected scripts/config/data; disk usage | Disabled |
| Delete files | Irreversible data loss | Disabled |
| Run tests | Executes repository code and side effects | Disabled unless trusted |
| Arbitrary commands | Full shell-level damage/exfiltration potential | Disabled |
| Whitelist | Safer but can block required files | Enabled with narrow patterns |
| Blacklist | Easy to bypass accidentally with unlisted names | Avoid for sensitive environments |
| Disable OS sandbox | No hard Codex isolation; account-wide exposure | Disabled; emergency compatibility only |
| Automatic apply/run | Changes or executes without final manual pause | Disabled for unfamiliar tasks |

### Data confidentiality

Any notebook cell, output, source file, configuration, error log, or command output inspected by Codex may be transmitted to the Codex service. Do not grant access to secrets, credentials, personal data, export-controlled information, confidential research data, or restricted datasets unless your organizational policy explicitly permits it.

### Prompt injection and untrusted repositories

Source files, notebooks, READMEs, test output, generated data, and dependency metadata can contain instructions that influence an agent. Treat unfamiliar repositories and downloaded notebooks as untrusted. Do not use Agent mode with broad permissions on unreviewed code.

### Version control is not a backup

Git can revert tracked source files, but not necessarily:

- untracked files;
- ignored files;
- external datasets;
- databases or services;
- submitted jobs;
- files outside the repository;
- secrets already disclosed.

Maintain independent backups for important data.

## Suggested configurations

### Inspect one imported module beside the notebook

Use case: determine what `from printWarning import warn` does.

```text
Project root: ./
Notebook directory: Read
Notebook subdirectories: No access
Referenced in notebook: Read or No access
Referenced in references: No access
Parent access: No access
Add files: Off
Delete files: Off
Run tests: Off
Arbitrary commands: Off
Policy boundaries: Enabled
Mode: Whitelist
Patterns: *.py
OS sandbox: Enabled, unless the cluster reports a bubblewrap failure
```

Because overlapping categories use the most permissive grant, `Notebook directory: Read` is sufficient for a local `.py` file even when `Referenced in notebook` is No access.

### Fix a local imported Python module

```text
Project root: ./
Notebook directory: Write
Notebook subdirectories: No access or Read
Referenced in notebook: Write
Referenced in references: Read
Parent access: No access
Add files: Off
Delete files: Off
Run tests: Off or On for a known targeted test
Arbitrary commands: Off
Whitelist: *.py
```

Keep a clean Git working tree and review `git diff` afterward.

### Refactor a trusted Python package and add tests

```text
Project root: repository root
Notebook directory: Write
Notebook subdirectories: Write
Referenced in notebook: Write
Referenced in references: Write
Parent access: No access
Add files: On
Delete files: Off initially
Run tests: On
Arbitrary commands: Off
Whitelist:
  *.py
  pyproject.toml
  ./tests/*
```

Enable Delete files only when the task explicitly removes or renames files.

### Read-only project analysis

```text
All required path categories: Read
All write categories: none
Add files: Off
Delete files: Off
Run tests: Off
Arbitrary commands: Off
Whitelist: relevant source/config extensions only
```

This selects the Codex `read-only` sandbox, but remember that detailed read restrictions remain policy instructions rather than a separately implemented ACL.

### Restricted cluster requiring compatibility mode

Use only after confirming the diagnostic error is a `bubblewrap`/namespace failure.

```text
Compatibility mode: On
Project root: narrow trusted repository
Path grants: minimum required
Whitelist: On
Add files: Off unless required
Delete files: Off
Run tests: Off initially
Arbitrary commands: Off
Git status: clean
Independent backup: available
```

## Authentication recovery

When Codex access is revoked, a token is invalidated, or a refresh token expires, the extension replaces the long 401 diagnostic with a recovery message.

Run the following commands in a JupyterLab terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
hash -r

codex logout
rm -f "${CODEX_HOME:-$HOME/.codex}/auth.json"

codex login --device-auth
codex login status

codex exec \
    --ephemeral \
    --skip-git-repo-check \
    "Reply with exactly: authentication works"
```

If the final command does not return the exact authentication test response, inspect the terminal output before retrying the extension.

## Keyboard shortcuts

### `@assistant` shortcut

Default: `Ctrl+Q`

Place a directive in an active code cell:

```python
# @assistant fix the error in this cell
```

Press the shortcut. The directive is removed from the cell and moved to the task field. In Codex mode, generation starts; in manual mode, the prompt is copied.

### Select active cell and all cells above

Default: `Ctrl+Alt+A`

`Ctrl+Shift+A` is commonly reserved by Firefox and Chromium-based browsers and may not reach JupyterLab.

### Input submission

Default:

- `Enter`: submit the current action;
- `Shift+Enter`: insert a new line.

The gear menu can reverse this behavior.

## Session history and patch recovery

**Session AI history** opens a second JupyterLab tab containing patches generated or parsed during the current browser session.

Each entry includes:

- timestamp;
- conversation/message sequence;
- original task;
- summary and notes;
- cell-numbered operations;
- applied/rejected/current state;
- before/after snapshots while retained.

Available actions can include:

- apply a previously unapplied patch;
- restore the exact notebook state from before an applied patch;
- replay an inverse patch while retaining unrelated later edits;
- reapply a previously undone patch;
- preview every action as a red/green diff before execution.

The gear-menu **Stored undo steps** setting controls how many recent entries retain complete snapshots. Older history entries remain visible, but full restoration data is discarded.

## Persistent user instructions

Open **Settings → User instructions…** to edit instructions appended to every generated Codex, manual ChatGPT, and `@assistant` prompt.

The text and enabled state are stored in browser local storage for the current JupyterLab site. Do not place secrets in persistent user instructions.

## Diagnostics

Run:

```bash
bash diagnostics.sh
```

Agent results also contain **Terminal diagnostics**, including:

- requested project root;
- resolved terminal/project root;
- approval policy;
- sandbox mode;
- Codex stderr;
- recent failed command events.

### `bwrap: pivot_root: Invalid argument`

This indicates that the cluster/container cannot start the Codex Linux sandbox. It is not a notebook file-permission error. Use compatibility mode only after reading its risks above.

## Development and testing

### Source layout

```text
src/                              TypeScript source
style/                            Extension CSS
jupyter_notebook_assistant/       Python package and built labextension
lib/                              Compiled TypeScript output
install.sh / uninstall.sh         User-local installation helpers
```

### Development setup

```bash
npm ci
npm run build:prod
python -m pip install -e .
```

For a linked development installation:

```bash
jupyter labextension develop --overwrite .
```

### Build a wheel and source distribution

```bash
python -m pip install build
python -m build
```

### Validate the frontend bundle

```bash
npm run build:prod
jupyter labextension list
```

## Publishing on GitHub

The repository metadata and settings-menu links assume this public repository:

```text
https://github.com/HighIander/jupyter-notebook-assistant
```

Create an empty repository with that name on GitHub. Do not initialize it with another README, `.gitignore`, or license because these files are already included.

From the project directory:

```bash
git init -b main
git add .
git commit -m "Initial public release"
git remote add origin git@github.com:HighIander/jupyter-notebook-assistant.git
git push -u origin main
```

HTTPS alternative:

```bash
git remote add origin https://github.com/HighIander/jupyter-notebook-assistant.git
```

### Recommended repository settings

- Enable Issues.
- Enable branch protection or a ruleset for `main`.
- Require the build workflow to pass before merging.
- Enable Dependabot alerts/updates according to your policy.
- Add repository topics such as `jupyterlab`, `jupyter`, `codex`, `chatgpt`, `ai-assistant`, and `notebook`.
- Review the AGPL implications before accepting external contributions.

### Create release `v0.1.27`

```bash
git tag -a v0.1.27 -m "Jupyter Notebook Assistant 0.1.27"
git push origin v0.1.27
```

The included release workflow builds the Python package and a standalone installation ZIP and attaches them to a GitHub Release for tags matching `v*`.

A manual release can also be created with GitHub CLI:

```bash
gh release create v0.1.27 \
    --title "Jupyter Notebook Assistant 0.1.27" \
    --notes-file CHANGELOG.md \
    jupyter-notebook-assistant-0.1.27.zip
```

See [RELEASE.md](RELEASE.md) for the full maintainer checklist.

## Security and disclaimers

### No warranty

This software is provided **as is**, without warranty of any kind. The author and contributors are not responsible for lost data, incorrect scientific results, corrupted notebooks, damaged repositories, leaked information, consumed compute allocations, submitted jobs, service disruption, or any other direct or indirect loss.

### Human review is mandatory

AI-generated code and explanations can be incorrect, incomplete, insecure, non-reproducible, or scientifically invalid. Review diffs, rerun validation, inspect numerical assumptions, and verify results independently.

### Agent mode is not a complete security boundary

- Detailed directory categories and white/blacklist patterns are mandatory prompt instructions, not an independently enforced filesystem ACL.
- `workspace-write` supplies an OS-enforced Codex sandbox for write locations, but does not replace careful policy design or host isolation.
- `danger-full-access` disables the Codex OS sandbox.
- Approval policy is `never` for non-interactive terminal execution.
- The JupyterHub account's host permissions and outer container/cluster controls are the final technical boundary.

### Do not use on sensitive data without authorization

Before use, verify institutional rules, data-protection requirements, software-export restrictions, experiment collaboration agreements, and acceptable-use policies for external AI services.

### Reproducibility

Record:

- extension version;
- Codex CLI version;
- model and reasoning settings;
- task prompt;
- permission settings;
- exact diff;
- test output;
- relevant environment and dependency versions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security-sensitive reports should follow [SECURITY.md](SECURITY.md).

## Citation

A `CITATION.cff` file is provided so GitHub can display citation metadata. Update the release date and DOI if a citable archive is later published through Zenodo or another repository.

## License

Copyright © 2026 Thomas Kluge.

This project is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE).

The AGPL allows use, study, modification, and redistribution under its terms. Modified versions offered for interaction over a computer network may trigger source-code availability obligations. This summary is not legal advice; the full license text controls.
