import {
  AgentPermissions,
  AssistantMode,
  CodexReasoningEffort,
  CodexSpeed,
  ContextOptions,
  DEFAULT_AGENT_PERMISSIONS,
  DEFAULT_CONTEXT_OPTIONS
} from './types';

export const STORAGE_KEY = 'jupyter-notebook-assistant:settings:v1';
export const DEFAULT_SHORTCUT = 'Ctrl+Q';
export const DEFAULT_SELECT_ABOVE_SHORTCUT = 'Ctrl+Alt+A';
export const DEFAULT_UNDO_HISTORY_LIMIT = 20;
const LEGACY_DEFAULT_USER_INSTRUCTION =
  'If a new feature is requested, add an explanation of how to use it into the summary and as comment in the code. Comment all code you generate or modify following best programming practices.';
// This default is applied to every generated prompt until the user edits or disables it.
export const DEFAULT_USER_INSTRUCTION = [
  '* If a new feature is requested, add an explanation of how to use it into the summary and as comment in the code.',
  '* Very important: Generate clean code. If the user supplied code is already messy, then at least don\'t make it more messy.',
  '* Important: New code should be as pythonic and compact as possible.',
  '* Best practice: Comment all code you generate or modify, following best programming practices. That means each function needs a documentation of at least the meaning and type of all parameters, what is the function doing, and what are the outputs. Add minimum usage examples of generated functions and objects as comments.',
  '* Please: Start each cell you modify with a comment giving a nummeration of the cell and a meaningful heading of what the cell does. Different functionality should go into separate cells if you are allowed to create new cells.'
].join('\n');

export interface PersistedSettings {
  mode: AssistantMode;
  workingMode: 'local' | 'agent';
  agentPermissions: AgentPermissions;
  loginInstructionsShown: boolean;
  contextOptions: ContextOptions;
  assistantShortcut: string;
  selectAboveShortcut: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexSpeed: CodexSpeed;
  autoApplyAfterParse: boolean;
  codexAutoApply: boolean;
  autoRunOnApply: boolean;
  userInstruction: string;
  includeUserInstruction: boolean;
  enterSubmits: boolean;
  undoHistoryLimit: number;
}

function cloneOptions(options: ContextOptions): ContextOptions {
  return { ...options };
}

function cloneAgentPermissions(
  permissions: AgentPermissions
): AgentPermissions {
  return { ...permissions };
}

function normalizeAgentAccess(value: unknown): AgentPermissions['notebookDirectory'] {
  return value === 'read' || value === 'write' ? value : 'none';
}

function normalizeAgentPermissions(value: unknown): AgentPermissions {
  const parsed = (value ?? {}) as Partial<AgentPermissions>;
  const numericLevels = Number(parsed.parentLevels);
  return {
    projectRoot:
      typeof parsed.projectRoot === 'string' && parsed.projectRoot.trim()
        ? parsed.projectRoot.trim()
        : DEFAULT_AGENT_PERMISSIONS.projectRoot,
    notebookDirectory: normalizeAgentAccess(parsed.notebookDirectory),
    notebookSubdirectories: normalizeAgentAccess(parsed.notebookSubdirectories),
    referencedInNotebook: normalizeAgentAccess(parsed.referencedInNotebook),
    referencedInReferences: normalizeAgentAccess(parsed.referencedInReferences),
    parentAccess: normalizeAgentAccess(parsed.parentAccess),
    parentLevels: Number.isFinite(numericLevels)
      ? Math.max(0, Math.min(20, Math.trunc(numericLevels)))
      : DEFAULT_AGENT_PERMISSIONS.parentLevels,
    addFiles: Boolean(parsed.addFiles),
    deleteFiles: Boolean(parsed.deleteFiles),
    runTests: Boolean(parsed.runTests),
    runArbitraryCommands: Boolean(parsed.runArbitraryCommands),
    disableCodexSandbox: Boolean(parsed.disableCodexSandbox),
    policyBoundariesEnabled:
      parsed.policyBoundariesEnabled === undefined
        ? DEFAULT_AGENT_PERMISSIONS.policyBoundariesEnabled
        : Boolean(parsed.policyBoundariesEnabled),
    patternMode:
      parsed.patternMode === 'blacklist' ? 'blacklist' : 'whitelist',
    patterns:
      typeof parsed.patterns === 'string'
        ? parsed.patterns
        : DEFAULT_AGENT_PERMISSIONS.patterns
  };
}

function normalizeUndoHistoryLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_UNDO_HISTORY_LIMIT;
  }
  return Math.max(1, Math.min(100, Math.trunc(numeric)));
}

export function loadSettings(): PersistedSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      throw new Error('No saved settings');
    }
    const parsed = JSON.parse(stored) as Partial<PersistedSettings>;
    const storedReasoningEffort = (parsed as { codexReasoningEffort?: string })
      .codexReasoningEffort;
    return {
      mode: parsed.mode === 'chatgpt' ? 'chatgpt' : 'codex',
      workingMode: parsed.workingMode === 'agent' ? 'agent' : 'local',
      agentPermissions: normalizeAgentPermissions(parsed.agentPermissions),
      loginInstructionsShown: Boolean(parsed.loginInstructionsShown),
      contextOptions: {
        ...DEFAULT_CONTEXT_OPTIONS,
        ...(parsed.contextOptions ?? {})
      },
      assistantShortcut:
        typeof parsed.assistantShortcut === 'string'
          ? parsed.assistantShortcut
          : DEFAULT_SHORTCUT,
      selectAboveShortcut:
        typeof parsed.selectAboveShortcut === 'string' &&
        parsed.selectAboveShortcut !== 'Ctrl+Shift+A'
          ? parsed.selectAboveShortcut
          : DEFAULT_SELECT_ABOVE_SHORTCUT,
      codexReasoningEffort:
        storedReasoningEffort === 'minimal'
          ? 'low'
          : ['low', 'medium', 'high', 'xhigh'].includes(
                storedReasoningEffort ?? ''
              )
            ? (storedReasoningEffort as CodexReasoningEffort)
            : 'medium',
      codexSpeed: parsed.codexSpeed === 'fast' ? 'fast' : 'normal',
      autoApplyAfterParse: Boolean(parsed.autoApplyAfterParse),
      codexAutoApply: Boolean(parsed.codexAutoApply),
      autoRunOnApply: Boolean(parsed.autoRunOnApply),
      userInstruction:
        typeof parsed.userInstruction === 'string' &&
        parsed.userInstruction !== LEGACY_DEFAULT_USER_INSTRUCTION
          ? parsed.userInstruction
          : DEFAULT_USER_INSTRUCTION,
      includeUserInstruction:
        parsed.includeUserInstruction === undefined
          ? true
          : Boolean(parsed.includeUserInstruction),
      enterSubmits:
        parsed.enterSubmits === undefined ? true : Boolean(parsed.enterSubmits),
      undoHistoryLimit: normalizeUndoHistoryLimit(parsed.undoHistoryLimit)
    };
  } catch {
    return {
      mode: 'codex',
      workingMode: 'local',
      agentPermissions: cloneAgentPermissions(DEFAULT_AGENT_PERMISSIONS),
      loginInstructionsShown: false,
      contextOptions: cloneOptions(DEFAULT_CONTEXT_OPTIONS),
      assistantShortcut: DEFAULT_SHORTCUT,
      selectAboveShortcut: DEFAULT_SELECT_ABOVE_SHORTCUT,
      codexReasoningEffort: 'medium',
      codexSpeed: 'normal',
      autoApplyAfterParse: false,
      codexAutoApply: false,
      autoRunOnApply: false,
      userInstruction: DEFAULT_USER_INSTRUCTION,
      includeUserInstruction: true,
      enterSubmits: true,
      undoHistoryLimit: DEFAULT_UNDO_HISTORY_LIMIT
    };
  }
}

export function saveSettings(settings: PersistedSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function getConfiguredShortcut(): string {
  return loadSettings().assistantShortcut;
}

export function getSelectAboveShortcut(): string {
  return loadSettings().selectAboveShortcut;
}
