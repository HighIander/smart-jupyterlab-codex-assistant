import type { KernelMessage, Session, Terminal } from '@jupyterlab/services';
import type { ServiceManager } from '@jupyterlab/services';

import {
  AgentRunResult,
  CodexReasoningEffort,
  CodexRunResult,
  CodexSpeed,
  NotebookPatch
} from './types';

const RESULT_START = '__JNA_RESULT_START__';
const RESULT_END = '__JNA_RESULT_END__';
const VALIDATION_START = '__JNA_VALIDATION_START__';
const VALIDATION_END = '__JNA_VALIDATION_END__';

export interface CodexRunOptions {
  reasoningEffort: CodexReasoningEffort;
  speed: CodexSpeed;
}

export interface CodexAgentRunOptions extends CodexRunOptions {
  projectRoot: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  additionalWriteDirectories: string[];
}

const CODEX_SANDBOX_COMPATIBILITY_MESSAGE = [
  'The Codex Linux sandbox could not start on this cluster.',
  '',
  'bubblewrap reported: bwrap: pivot_root: Invalid argument',
  '',
  'This is a cluster or container limitation, not a notebook-file permission problem. Open Agent mode settings and enable “Cluster compatibility mode: disable the Codex OS sandbox”, then retry.',
  '',
  'Warning: compatibility mode runs Codex with danger-full-access. The configured directory permissions and white-/blacklist remain mandatory agent instructions, but they are not enforced by an operating-system sandbox.'
].join('\n');

const CODEX_AUTH_RECOVERY_MESSAGE = [
  'Codex could not be authenticated.',
  '',
  'Please sign in again by running the following commands in a JupyterLab terminal:',
  '',
  'export PATH="$HOME/.local/bin:$PATH"',
  'hash -r',
  '',
  'codex logout',
  'rm -f "${CODEX_HOME:-$HOME/.codex}/auth.json"',
  '',
  'codex login --device-auth',
  'codex login status',
  '',
  'codex exec \\',
  '    --ephemeral \\',
  '    --skip-git-repo-check \\',
  '    "Reply with exactly: authentication works"'
].join('\n');

function formatCodexError(message: string): string {
  const normalized = stripAnsi(message || 'Codex returned no result.');
  const authenticationFailure = [
    '401 unauthorized',
    'token_invalidated',
    'refresh_token_invalidated',
    'authentication token has been invalidated',
    'your session has ended',
    'identity_edge_internal_error',
    'failed to refresh token'
  ].some(pattern => normalized.toLowerCase().includes(pattern));
  const sandboxFailure = [
    'bwrap: pivot_root: invalid argument',
    'bwrap: creating new namespace failed',
    'bwrap: no permissions to create new namespace',
    'unable to create new user namespace'
  ].some(pattern => normalized.toLowerCase().includes(pattern));
  if (authenticationFailure) {
    return CODEX_AUTH_RECOVERY_MESSAGE;
  }
  return sandboxFailure ? CODEX_SANDBOX_COMPATIBILITY_MESSAGE : normalized;
}

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: [
              'replace',
              'insert_before',
              'insert_after',
              'append',
              'delete',
              'move_before',
              'move_after'
            ]
          },
          cell_id: { type: 'string' },
          reference_cell_id: { type: 'string' },
          cell_type: { type: 'string', enum: ['code', 'markdown'] },
          source: { type: 'string' },
          reason: { type: 'string' }
        },
        required: [
          'operation',
          'cell_id',
          'reference_cell_id',
          'cell_type',
          'source',
          'reason'
        ],
        additionalProperties: false
      }
    },
    notes: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['summary', 'operations', 'notes'],
  additionalProperties: false
};


function stripAnsi(value: string): string {
  // ANSI control sequences always begin with ESC (U+001B). Requiring the
  // prefix prevents ordinary Python indexing such as values[mask] from being
  // mistaken for a terminal colour reset and silently losing the characters
  // "[m" during transport.
  return value.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '');
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function parseKernelResult(text: string): CodexRunResult {
  const start = text.lastIndexOf(RESULT_START);
  const end = text.lastIndexOf(RESULT_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `The helper kernel returned no parseable result.\n${stripAnsi(text.slice(-4000))}`
    );
  }
  const payloadText = text
    .slice(start + RESULT_START.length, end)
    .trim();
  const payload = JSON.parse(payloadText) as {
    ok: boolean;
    result?: NotebookPatch;
    thread_id?: string | null;
    diagnostics?: string;
    error?: string;
  };
  if (!payload.ok || !payload.result) {
    throw new Error(formatCodexError(payload.error || 'Codex returned no patch.'));
  }
  return {
    patch: payload.result,
    threadId: payload.thread_id ?? null,
    diagnostics: stripAnsi(payload.diagnostics ?? '')
  };
}

export class CodexRunner {
  constructor(private readonly services: ServiceManager.IManager) {}

  private session: Session.ISessionConnection | null = null;
  private terminal: Terminal.ITerminalConnection | null = null;

  async dispose(): Promise<void> {
    if (this.terminal) {
      const terminal = this.terminal;
      this.terminal = null;
      try {
        await terminal.shutdown();
      } catch {
        // The Jupyter server may already have removed the agent terminal.
      }
      terminal.dispose();
    }
    if (this.session) {
      const id = this.session.id;
      this.session.dispose();
      this.session = null;
      try {
        await this.services.sessions.shutdown(id);
      } catch {
        // The Jupyter server may already have removed the helper session.
      }
    }
  }

  async cancel(): Promise<void> {
    if (this.terminal) {
      const terminal = this.terminal;
      this.terminal = null;
      try {
        terminal.send({ type: 'stdin', content: ['\u0003'] });
        await terminal.shutdown();
      } catch {
        // Cancellation is best-effort if the terminal already exited.
      }
      terminal.dispose();
    }
    if (this.session?.kernel) {
      await this.session.kernel.interrupt();
    }
  }

  async runAgent(
    prompt: string,
    options: CodexAgentRunOptions,
    onStatus: (message: string) => void
  ): Promise<AgentRunResult> {
    await this.services.ready;
    if (!this.services.terminals.isAvailable()) {
      throw new Error(
        'The Jupyter terminal service is unavailable on this server. Agent mode requires TerminalManager access.'
      );
    }

    if (this.terminal) {
      try {
        await this.terminal.shutdown();
      } catch {
        // A stale terminal connection can be discarded before the new run.
      }
      this.terminal.dispose();
      this.terminal = null;
    }

    onStatus('Starting a dedicated Jupyter terminal for agent mode…');
    const terminal = await this.services.terminals.startNew({
      cwd: options.projectRoot
    });
    this.terminal = terminal;

    const nonce = crypto.randomUUID().replace(/-/g, '');
    const resultStart = `__JNA_AGENT_RESULT_START_${nonce}__`;
    const resultEnd = `__JNA_AGENT_RESULT_END_${nonce}__`;
    const prompt64 = encodeBase64(prompt);
    const script = `
import base64
import json
import pathlib
import re
import shutil
import subprocess
import tempfile

RESULT_START = ${JSON.stringify(resultStart)}
RESULT_END = ${JSON.stringify(resultEnd)}
prompt = base64.b64decode(${JSON.stringify(prompt64)}).decode("utf-8")
reasoning_effort = ${JSON.stringify(options.reasoningEffort)}
speed = ${JSON.stringify(options.speed)}
sandbox = ${JSON.stringify(options.sandbox)}
requested_project_root = ${JSON.stringify(options.projectRoot)}
additional_write_directories = ${JSON.stringify(options.additionalWriteDirectories)}
payload = {"ok": False}
proc = None

def strip_ansi(value):
    value = value or ""
    return re.sub(r"\\x1b(?:\\[[0-?]*[ -/]*[@-~]|[@-_])", "", value)

try:
    codex = shutil.which("codex")
    if not codex:
        local_codex = pathlib.Path.home() / ".local" / "bin" / "codex"
        if local_codex.is_file():
            codex = str(local_codex)
    if not codex:
        raise RuntimeError(
            "Codex CLI was not found in PATH. Install it and run "
            "'codex login --device-auth' in a JupyterLab terminal."
        )

    # The Jupyter terminal API resolves its cwd against the Jupyter server root
    # and starts the shell in the resulting real filesystem directory. Use the
    # terminal's actual cwd as the authoritative Codex workspace instead of
    # resolving the Jupyter-relative path a second time.
    launch_cwd = pathlib.Path.cwd().resolve()
    project_root = launch_cwd

    if not project_root.is_dir():
        raise RuntimeError(
            "The terminal working directory is not available: %s" % project_root
        )

    resolved_write_directories = []
    for directory in additional_write_directories:
        if not directory:
            continue
        candidate = pathlib.Path(directory).expanduser()
        if not candidate.is_absolute():
            candidate = (project_root / candidate).resolve()
        else:
            candidate = candidate.resolve()
        if not candidate.is_dir():
            raise RuntimeError(
                "An additional writable directory does not exist: %s" % candidate
            )
        resolved_write_directories.append(str(candidate))

    with tempfile.TemporaryDirectory(prefix="jna-agent-result-") as tmp:
        output_path = pathlib.Path(tmp) / "last-message.txt"
        command = [
            codex,
            "--sandbox", sandbox,
            "--ask-for-approval", "never",
            "--cd", str(project_root),
            "-c", 'model_reasoning_effort="%s"' % reasoning_effort,
        ]
        if speed == "fast":
            command.extend(["-c", 'service_tier="fast"'])
        if sandbox != "danger-full-access":
            for directory in resolved_write_directories:
                if directory:
                    command.extend(["--add-dir", directory])
        command.extend([
            "exec",
            "--ephemeral",
            "--json",
            "--skip-git-repo-check",
            "-o", str(output_path),
            "-",
        ])
        proc = subprocess.Popen(
            command,
            cwd=str(project_root),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout, stderr = proc.communicate(prompt)
        if proc.returncode != 0:
            raise RuntimeError(
                "Codex exited with status %s.\\n%s" %
                (proc.returncode, strip_ansi((stderr or stdout)[-12000:]))
            )
        if not output_path.exists():
            raise RuntimeError("Codex did not produce a final agent message.")

        thread_id = None
        command_failures = []
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except Exception:
                continue
            if event.get("type") == "thread.started":
                thread_id = event.get("thread_id")
            item = event.get("item") or {}
            if (
                event.get("type") == "item.completed"
                and item.get("type") == "command_execution"
                and item.get("status") not in (None, "completed", "success")
            ):
                command_failures.append(
                    json.dumps(item, ensure_ascii=False, indent=2)[-4000:]
                )

        command_failure_text = ""
        if command_failures:
            command_failure_text = (
                "\\nFailed command events reported by Codex:\\n"
                + "\\n---\\n".join(command_failures[-3:])
            )

        sandbox_failure_text = (stderr + "\\n" + "\\n".join(command_failures)).lower()
        sandbox_failed = sandbox != "danger-full-access" and any(
            marker in sandbox_failure_text
            for marker in (
                "bwrap: pivot_root: invalid argument",
                "bwrap: creating new namespace failed",
                "bwrap: no permissions to create new namespace",
                "unable to create new user namespace",
            )
        )
        if sandbox_failed:
            raise RuntimeError(
                "The Codex Linux sandbox could not start on this cluster.\\n\\n"
                "bubblewrap reported: bwrap: pivot_root: Invalid argument\\n\\n"
                "This is a cluster or container limitation, not a notebook-file permission problem. "
                "Open Agent mode settings and enable 'Cluster compatibility mode: disable the Codex OS sandbox', then retry.\\n\\n"
                "Warning: compatibility mode runs Codex with danger-full-access. The configured directory permissions "
                "and white-/blacklist remain mandatory agent instructions, but they are not enforced by an operating-system sandbox."
            )

        payload = {
            "ok": True,
            "summary": output_path.read_text(encoding="utf-8"),
            "thread_id": thread_id,
            "diagnostics": strip_ansi(
                (
                    "Requested project root: %s\\n"
                    "Resolved terminal/project root: %s\\n"
                    "Approval policy: never\\n"
                    "Sandbox: %s\\n%s%s"
                )
                % (
                    requested_project_root,
                    project_root,
                    sandbox,
                    stderr[-5000:],
                    command_failure_text,
                )
            ),
        }
except KeyboardInterrupt:
    if proc is not None and proc.poll() is None:
        proc.terminate()
    payload = {"ok": False, "error": "Codex execution was cancelled."}
except Exception as exc:
    payload = {"ok": False, "error": strip_ansi(str(exc))}

print(RESULT_START)
print(json.dumps(payload, ensure_ascii=False))
print(RESULT_END)
`;

    const script64 = encodeBase64(script);
    let output = '';
    let settled = false;

    const completion = new Promise<AgentRunResult>((resolve, reject) => {
      const finish = (): void => {
        if (settled) {
          return;
        }
        const cleaned = stripAnsi(output).replace(/\r/g, '');
        const start = cleaned.lastIndexOf(resultStart);
        const end = cleaned.lastIndexOf(resultEnd);
        if (start < 0 || end < 0 || end <= start) {
          return;
        }
        settled = true;
        const payloadText = cleaned
          .slice(start + resultStart.length, end)
          .trim();
        try {
          const payload = JSON.parse(payloadText) as {
            ok: boolean;
            summary?: string;
            thread_id?: string | null;
            diagnostics?: string;
            error?: string;
          };
          if (!payload.ok) {
            reject(new Error(formatCodexError(payload.error || 'Codex agent failed.')));
            return;
          }
          resolve({
            summary: payload.summary?.trim() || 'Agent run completed.',
            threadId: payload.thread_id ?? null,
            diagnostics: stripAnsi(payload.diagnostics ?? '')
          });
        } catch (error) {
          reject(
            new Error(
              `The agent terminal returned an invalid result: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          );
        }
      };

      terminal.messageReceived.connect((_sender, message) => {
        if (message.type !== 'stdout') {
          return;
        }
        output += (message.content ?? []).map(value => String(value)).join('');
        finish();
      });
      terminal.disposed.connect(() => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `The agent terminal closed before Codex returned a result.\n${stripAnsi(
                output.slice(-5000)
              )}`
            )
          );
        }
      });
    });

    onStatus('Transferring the task to the agent terminal…');
    terminal.send({ type: 'stdin', content: ['stty -echo\r'] });
    terminal.send({
      type: 'stdin',
      content: [
        `JNA_B64=$(mktemp "\${TMPDIR:-/tmp}/jna-agent.XXXXXX"); : > "$JNA_B64"\r`
      ]
    });
    for (let offset = 0; offset < script64.length; offset += 6000) {
      const chunk = script64.slice(offset, offset + 6000);
      terminal.send({
        type: 'stdin',
        content: [`printf '%s' '${chunk}' >> "$JNA_B64"\r`]
      });
    }
    const fallbackPayload = JSON.stringify({
      ok: false,
      error: 'The Python helper in the Jupyter terminal failed before Codex returned a result.'
    });
    terminal.send({
      type: 'stdin',
      content: [
        `base64 -d "$JNA_B64" > "$JNA_B64.py" && python3 "$JNA_B64.py"; JNA_STATUS=$?; if [ $JNA_STATUS -ne 0 ]; then printf '\\n%s\\n%s\\n%s\\n' '${resultStart}' '${fallbackPayload}' '${resultEnd}'; fi; rm -f "$JNA_B64" "$JNA_B64.py"; stty echo\r`
      ]
    });

    onStatus('Codex agent is analysing the project within the configured permissions…');
    try {
      return await completion;
    } finally {
      if (this.terminal === terminal) {
        this.terminal = null;
      }
      try {
        await terminal.shutdown();
      } catch {
        // The shell may already have terminated after the command completed.
      }
      terminal.dispose();
    }
  }

  private async ensureSession(kernelName: string): Promise<Session.ISessionConnection> {
    if (this.session && !this.session.isDisposed && this.session.kernel) {
      return this.session;
    }
    await this.services.ready;
    const session = await this.services.sessions.startNew({
      path: `.jupyter-notebook-assistant/helper-${crypto.randomUUID()}.json`,
      name: 'Jupyter Notebook Assistant helper',
      type: 'console',
      kernel: { name: kernelName }
    });
    this.session = session;
    return session;
  }

  async validatePythonSources(
    sources: Array<{ label: string; source: string }>,
    kernelName: string
  ): Promise<void> {
    if (!sources.length) {
      return;
    }

    const session = await this.ensureSession(kernelName);
    if (!session.kernel) {
      throw new Error('The helper session has no kernel.');
    }

    const sources64 = encodeBase64(JSON.stringify(sources));
    const pythonCode = `
import ast
import base64
import json

VALIDATION_START = ${JSON.stringify(VALIDATION_START)}
VALIDATION_END = ${JSON.stringify(VALIDATION_END)}
sources = json.loads(base64.b64decode(${JSON.stringify(sources64)}).decode("utf-8"))
errors = []

try:
    from IPython.core.inputtransformer2 import TransformerManager
    transformer = TransformerManager()
except Exception:
    transformer = None

for item in sources:
    label = str(item.get("label") or "code cell")
    source = str(item.get("source") or "")
    try:
        transformed = transformer.transform_cell(source) if transformer else source
        flags = ast.PyCF_ONLY_AST | getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0)
        compile(
            transformed,
            "<assistant patch: %s>" % label,
            "exec",
            flags=flags,
            dont_inherit=True,
        )
    except SyntaxError as exc:
        line = (exc.text or "").rstrip("\\n")
        pointer = ""
        if line and exc.offset:
            pointer = " " * max(int(exc.offset) - 1, 0) + "^"
        details = "%s: %s (line %s, column %s)" % (
            label,
            exc.msg,
            exc.lineno or "?",
            exc.offset or "?",
        )
        if line:
            details += "\\n" + line
        if pointer:
            details += "\\n" + pointer
        errors.append(details)
    except Exception as exc:
        errors.append("%s: syntax validation failed: %s" % (label, exc))

payload = {
    "ok": not errors,
    "errors": errors,
}
print(VALIDATION_START)
print(json.dumps(payload, ensure_ascii=False))
print(VALIDATION_END)
`;

    let output = '';
    const future = session.kernel.requestExecute(
      { code: pythonCode, stop_on_error: true },
      false
    );
    future.onIOPub = message => {
      if (message.header.msg_type === 'stream') {
        const content = message.content as KernelMessage.IStreamMsg['content'];
        output += Array.isArray(content.text)
          ? content.text.join('')
          : content.text;
      } else if (message.header.msg_type === 'error') {
        const content = message.content as KernelMessage.IErrorMsg['content'];
        output += `\n${content.ename}: ${content.evalue}\n${content.traceback.join('\n')}`;
      }
    };
    await future.done;

    const cleaned = stripAnsi(output);
    const start = cleaned.lastIndexOf(VALIDATION_START);
    const end = cleaned.lastIndexOf(VALIDATION_END);
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(
        `Python syntax validation returned no parseable result.\n${cleaned.slice(-4000)}`
      );
    }
    const payloadText = cleaned
      .slice(start + VALIDATION_START.length, end)
      .trim();
    const payload = JSON.parse(payloadText) as {
      ok: boolean;
      errors?: string[];
    };
    if (!payload.ok) {
      throw new Error(
        `Patch not applied because generated Python is syntactically invalid:\n${(
          payload.errors ?? ['Unknown syntax error.']
        ).join('\n\n')}`
      );
    }
  }

  async run(
    prompt: string,
    kernelName: string,
    options: CodexRunOptions,
    onStatus: (message: string) => void
  ): Promise<CodexRunResult> {
    const session = await this.ensureSession(kernelName);
    if (!session.kernel) {
      throw new Error('The helper session has no kernel.');
    }

    const prompt64 = encodeBase64(prompt);
    const schema64 = encodeBase64(JSON.stringify(PATCH_SCHEMA));
    const reasoningEffort = options.reasoningEffort;
    const speed = options.speed;
    const pythonCode = `
import base64
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

RESULT_START = ${JSON.stringify(RESULT_START)}
RESULT_END = ${JSON.stringify(RESULT_END)}
prompt = base64.b64decode(${JSON.stringify(prompt64)}).decode("utf-8")
schema_text = base64.b64decode(${JSON.stringify(schema64)}).decode("utf-8")
reasoning_effort = ${JSON.stringify(reasoningEffort)}
speed = ${JSON.stringify(speed)}
payload = {"ok": False}
proc = None

def strip_ansi(value):
    value = value or ""
    # ANSI control sequences require an ESC prefix. Bare text such as "[m"
    # is valid Python source and must never be removed from generated patches.
    return re.sub(r"\\x1b(?:\\[[0-?]*[ -/]*[@-~]|[@-_])", "", value)
try:
    codex = shutil.which("codex")
    if not codex:
        local_codex = pathlib.Path.home() / ".local" / "bin" / "codex"
        if local_codex.is_file():
            codex = str(local_codex)
    if not codex:
        raise RuntimeError(
            "Codex CLI was not found in PATH. Install it and run "
            "'codex login --device-auth' in a JupyterLab terminal."
        )
    with tempfile.TemporaryDirectory(prefix="jna-codex-") as tmp:
        tmp_path = pathlib.Path(tmp)
        schema_path = tmp_path / "patch-schema.json"
        output_path = tmp_path / "patch.json"
        schema_path.write_text(schema_text, encoding="utf-8")
        command = [
            codex,
            "--sandbox", "read-only",
            "--ask-for-approval", "never",
            "-c", 'model_reasoning_effort="%s"' % reasoning_effort,
        ]
        if speed == "fast":
            command.extend(["-c", 'service_tier="fast"'])
        command.extend([
            "exec",
            "--ephemeral",
            "--json",
            "--skip-git-repo-check",
            "--output-schema", str(schema_path),
            "-o", str(output_path),
            "-",
        ])
        proc = subprocess.Popen(
            command,
            cwd=tmp,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout, stderr = proc.communicate(prompt)
        if proc.returncode != 0:
            raise RuntimeError(
                "Codex exited with status %s.\\n%s" %
                (proc.returncode, strip_ansi((stderr or stdout)[-8000:]))
            )
        if not output_path.exists():
            raise RuntimeError("Codex did not produce the requested structured output file.")
        result = json.loads(output_path.read_text(encoding="utf-8"))
        thread_id = None
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except Exception:
                continue
            if event.get("type") == "thread.started":
                thread_id = event.get("thread_id")
        payload = {
            "ok": True,
            "result": result,
            "thread_id": thread_id,
            "diagnostics": strip_ansi(stderr[-4000:]),
        }
except KeyboardInterrupt:
    if proc is not None and proc.poll() is None:
        proc.terminate()
    payload = {"ok": False, "error": "Codex execution was cancelled."}
except Exception as exc:
    payload = {"ok": False, "error": strip_ansi(str(exc))}
print(RESULT_START)
print(json.dumps(payload, ensure_ascii=False))
print(RESULT_END)
`;

    onStatus('Starting the dedicated helper kernel…');
    let output = '';
    const future = session.kernel.requestExecute(
      { code: pythonCode, stop_on_error: true },
      false
    );
    future.onIOPub = message => {
      if (message.header.msg_type === 'stream') {
        const content = message.content as KernelMessage.IStreamMsg['content'];
        output += Array.isArray(content.text)
          ? content.text.join('')
          : content.text;
      } else if (message.header.msg_type === 'error') {
        const content = message.content as KernelMessage.IErrorMsg['content'];
        output += `\n${content.ename}: ${content.evalue}\n${content.traceback.join('\n')}`;
      }
    };
    onStatus('Codex is analysing the supplied notebook context…');
    await future.done;
    onStatus('Validating the structured notebook patch…');
    return parseKernelResult(stripAnsi(output));
  }
}
