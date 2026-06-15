export type AssistantMode = 'codex' | 'chatgpt';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CodexSpeed = 'normal' | 'fast';
export type EditScope = 'active' | 'selected' | 'any';
export type WorkingMode = 'local' | 'agent';
export type AgentAccess = 'none' | 'read' | 'write';
export type AgentPatternMode = 'whitelist' | 'blacklist';

export interface AgentPermissions {
  projectRoot: string;
  notebookDirectory: AgentAccess;
  notebookSubdirectories: AgentAccess;
  referencedInNotebook: AgentAccess;
  referencedInReferences: AgentAccess;
  parentAccess: AgentAccess;
  parentLevels: number;
  addFiles: boolean;
  deleteFiles: boolean;
  runTests: boolean;
  runArbitraryCommands: boolean;
  disableCodexSandbox: boolean;
  policyBoundariesEnabled: boolean;
  patternMode: AgentPatternMode;
  patterns: string;
}

export interface ContextOptions {
  includeSelected: boolean;
  includeBefore: boolean;
  includeOutputs: boolean;
  includeAfter: boolean;
  includeMarkdownContext: boolean;
  editScope: EditScope;
  allowMarkdownChanges: boolean;
  allowDeleteMove: boolean;
  maxTextOutputChars: number;
}

export interface NotebookCellContext {
  id: string;
  index: number;
  cellType: 'code' | 'markdown' | 'raw';
  source: string;
  sourceHash: string;
  active: boolean;
  selected: boolean;
  executionCount: number | null;
  outputText: string;
}

export interface NotebookContext {
  notebookName: string;
  activeCellIndex: number;
  activeCellId: string;
  selectedCellIndexes: number[];
  selectedCellIds: string[];
  cells: NotebookCellContext[];
  characterCount: number;
  estimatedTokens: number;
}

export type PatchOperationType =
  | 'replace'
  | 'insert_before'
  | 'insert_after'
  | 'append'
  | 'delete'
  | 'move_before'
  | 'move_after';

export interface PatchOperation {
  operation: PatchOperationType;
  cell_id: string;
  reference_cell_id: string;
  cell_type: 'code' | 'markdown';
  source: string;
  reason: string;
}

export interface NotebookPatch {
  summary: string;
  operations: PatchOperation[];
  notes: string[];
}

export interface CodexRunResult {
  patch: NotebookPatch;
  threadId: string | null;
  diagnostics: string;
}

export interface AgentRunResult {
  summary: string;
  threadId: string | null;
  diagnostics: string;
}

export const DEFAULT_CONTEXT_OPTIONS: ContextOptions = {
  includeSelected: true,
  includeBefore: true,
  includeOutputs: true,
  includeAfter: false,
  includeMarkdownContext: true,
  editScope: 'any',
  allowMarkdownChanges: false,
  allowDeleteMove: false,
  maxTextOutputChars: 20_000
};

export const DEFAULT_AGENT_PERMISSIONS: AgentPermissions = {
  projectRoot: './',
  notebookDirectory: 'none',
  notebookSubdirectories: 'none',
  referencedInNotebook: 'none',
  referencedInReferences: 'none',
  parentAccess: 'none',
  parentLevels: 1,
  addFiles: false,
  deleteFiles: false,
  runTests: false,
  runArbitraryCommands: false,
  disableCodexSandbox: false,
  policyBoundariesEnabled: true,
  patternMode: 'whitelist',
  patterns: '*.py\n*.ipynb'
};
