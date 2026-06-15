import { MainAreaWidget } from '@jupyterlab/apputils';
import type { INotebookTracker } from '@jupyterlab/notebook';
import type { ServiceManager } from '@jupyterlab/services';
import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import { AssistantMode, ContextOptions, NotebookContext, NotebookPatch } from './types';
export type SessionHistoryState = 'generated' | 'applied' | 'undone';
export interface SessionHistoryEntry {
    id: number;
    conversationNumber: number;
    messageNumber: number;
    timestamp: number;
    mode: AssistantMode;
    inputText: string;
    patch: NotebookPatch;
    context: NotebookContext;
    options: ContextOptions;
    selectedOperationIndexes: number[];
    beforeSnapshot: unknown | null;
    afterSnapshot: unknown | null;
    state: SessionHistoryState;
}
type SessionHistoryListener = () => void;
export declare class SessionHistoryStore {
    private entries;
    private listeners;
    private nextId;
    private conversationNumber;
    private messageNumber;
    private undoLimit;
    getEntries(): SessionHistoryEntry[];
    nextMessagePosition(): {
        conversationNumber: number;
        messageNumber: number;
    };
    startNewConversation(): void;
    setUndoLimit(limit: number): void;
    add(entry: Omit<SessionHistoryEntry, 'id'>): SessionHistoryEntry;
    update(id: number, changes: Partial<Omit<SessionHistoryEntry, 'id'>>): void;
    private trimUndoSnapshots;
    subscribe(listener: SessionHistoryListener): () => void;
    private emit;
}
export declare class AssistantContent extends Widget {
    private readonly tracker;
    private readonly requestActivation?;
    private readonly historyStore;
    private readonly requestHistoryOpen?;
    constructor(tracker: INotebookTracker, services: ServiceManager.IManager, requestActivation?: (() => void) | undefined, historyStore?: SessionHistoryStore, requestHistoryOpen?: ((entryId?: number) => void) | undefined);
    private mode;
    private workingMode;
    private agentPermissions;
    private loginInstructionsShown;
    private contextOptions;
    private assistantShortcut;
    private selectAboveShortcut;
    private codexReasoningEffort;
    private codexSpeed;
    private autoApplyAfterParseSetting;
    private codexAutoApplySetting;
    private autoRunOnApplySetting;
    private userInstruction;
    private includeUserInstruction;
    private enterSubmits;
    private undoHistoryLimit;
    private readonly codexRunner;
    private statusFrame;
    private statusDirty;
    private currentPatch;
    private patchContext;
    private patchOptions;
    private pendingManualContext;
    private pendingManualOptions;
    private operationChecks;
    private undoSnapshot;
    private busy;
    private detailsCollapsed;
    private patchApplied;
    private currentHistoryEntryId;
    private historyUnsubscribe;
    private feedbackTimers;
    private successBannerTimer;
    private generateLockedUntilInput;
    private contentNode;
    private agentBanner;
    private successBanner;
    private modeCodexButton;
    private modeChatGPTButton;
    private newConversationButton;
    private loginButton;
    private settingsDetails;
    private taskInput;
    private codexOptions;
    private reasoningSelect;
    private speedSelect;
    private contextButton;
    private agentModeButton;
    private agentModeToggle;
    private codexActions;
    private chatGPTActions;
    private generateButton;
    private cancelButton;
    private workingLabel;
    private openChatGPTButton;
    private copyPromptButton;
    private responseInput;
    private parseButton;
    private autoParseAfterPaste;
    private autoApplyAfterParse;
    private codexAutoApply;
    private manualAutoApplyLine;
    private codexAutoApplyLine;
    private autoRunOnApply;
    private resultSection;
    private resultNode;
    private patchDetailsNode;
    private detailsToggleButton;
    private statusMessage;
    private targetStatus;
    private processStatus;
    private historyButton;
    private applyButton;
    private rejectButton;
    private undoButton;
    private patchActionRow;
    dispose(): void;
    private get panel();
    private persistSettings;
    private buildUI;
    private isReadyButton;
    private shouldSubmitFromInput;
    private runTaskFieldPrimaryAction;
    private runPasteFieldPrimaryAction;
    private setButtonState;
    private flashButtonSuccess;
    private showPatchAppliedBanner;
    private setDetailsCollapsed;
    private resetManualVisualState;
    private updateManualTaskState;
    private updateManualPasteState;
    private clearResultState;
    private openCodexLoginDialog;
    private initializeCodexTaskField;
    private setMode;
    private updateModeUI;
    private updateWorkingModeUI;
    private confirmAgentActivation;
    private setWorkingMode;
    private toggleAgentMode;
    private createAgentAccessSelect;
    private openAgentModeDialog;
    protected onAfterShow(message: Message): void;
    private onNotebookTargetChanged;
    private scheduleNotebookStatusRefresh;
    private refreshNotebookStatus;
    private setStatus;
    private updateGenerateButtonState;
    private setBusy;
    private requirePanel;
    consumeAssistantDirective(): Promise<void>;
    private buildPrompt;
    private buildAgentPrompt;
    private renderAgentResult;
    private runAgentTask;
    private prepareForManualResponse;
    private copyTextSynchronously;
    private writeClipboard;
    private copyPrompt;
    private openChatGPT;
    private generateCodexPatch;
    private cancelCodex;
    private parseManualResponse;
    private resetConversation;
    private renderEmptyResult;
    private rejectPatch;
    private setApplyButtonReady;
    private resetAppliedButtonForEditing;
    private syncCurrentHistoryState;
    private recordHistoryEntry;
    private renderPatch;
    private currentCellIndex;
    private validateOperation;
    private makeCellData;
    private applyOperationsToPanel;
    private runChangedCodeCells;
    /**
     * Apply a previously generated patch from the session-history window.
     *
     * The stored source hashes and edit permissions are checked against the
     * current notebook before any change is made. This prevents an old patch
     * from being applied blindly after its target cells have changed.
     *
     * @param entryId - Internal identifier of the session-history entry.
     * @returns A user-facing description of the completed action.
     *
     * @example
     * // Invoked by the Session AI history "Apply now" button.
     * await assistant.applyHistoryEntry(entry.id);
     */
    applyHistoryEntry(entryId: number): Promise<string>;
    private applyPatch;
    private undoChanges;
    private openUserInstructionsDialog;
    private openContextDialog;
}
export declare class SessionHistoryContent extends Widget {
    private readonly tracker;
    private readonly historyStore;
    private readonly requestApply?;
    private readonly requestClose?;
    constructor(tracker: INotebookTracker, historyStore: SessionHistoryStore, requestApply?: ((entryId: number) => Promise<string>) | undefined, requestClose?: (() => void) | undefined);
    private currentIndex;
    private lastEntryCount;
    private unsubscribe;
    private metadataNode;
    private positionNode;
    private previousButton;
    private nextButton;
    private slider;
    private contentNode;
    private applyNowButton;
    private restoreButton;
    private replayButton;
    private statusNode;
    private actionInProgress;
    dispose(): void;
    private buildUI;
    private onHistoryChanged;
    private move;
    private currentEntry;
    /**
     * Select a history entry when the history tab is opened from a specific
     * patch action in the assistant sidebar.
     *
     * @param entryId - Internal ID of the history entry to display.
     */
    selectEntry(entryId: number): void;
    private renderCurrent;
    private findNotebook;
    private requireNotebook;
    private snapshotPanel;
    private ensureNotebookUnchanged;
    private confirmChange;
    private setActionsBusy;
    private finishAction;
    /**
     * Preview and apply the currently displayed patch that has not yet been
     * applied. The final mutation still uses the assistant's normal validation
     * path after the user confirms the calculated notebook diff.
     */
    private applyCurrent;
    /**
     * Preview and restore the complete recorded notebook state before or after
     * the selected patch. This exact restoration intentionally replaces every
     * intervening notebook edit represented in the preview.
     */
    private restoreCurrent;
    /**
     * Preview and replay only the recorded patch delta in the forward or inverse
     * direction. Unrelated current edits are retained, while cells touched by
     * the patch can still be overwritten, inserted, deleted, or moved.
     */
    private replayCurrent;
    private setStatus;
}
export declare function createHistoryMainWidget(content: SessionHistoryContent): MainAreaWidget<SessionHistoryContent>;
export declare function createAssistantMainWidget(content: AssistantContent): MainAreaWidget<AssistantContent>;
export {};
