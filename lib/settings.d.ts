import { AgentPermissions, AssistantMode, CodexReasoningEffort, CodexSpeed, ContextOptions } from './types';
export declare const STORAGE_KEY = "jupyter-notebook-assistant:settings:v1";
export declare const DEFAULT_SHORTCUT = "Ctrl+Q";
export declare const DEFAULT_SELECT_ABOVE_SHORTCUT = "Ctrl+Alt+A";
export declare const DEFAULT_UNDO_HISTORY_LIMIT = 20;
export declare const DEFAULT_USER_INSTRUCTION: string;
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
export declare function loadSettings(): PersistedSettings;
export declare function saveSettings(settings: PersistedSettings): void;
export declare function getConfiguredShortcut(): string;
export declare function getSelectAboveShortcut(): string;
