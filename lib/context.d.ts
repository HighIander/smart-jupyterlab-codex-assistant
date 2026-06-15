import type { NotebookPanel } from '@jupyterlab/notebook';
import { ContextOptions, NotebookContext } from './types';
export declare function sourceHash(source: string): string;
export declare function countNotebookContextCells(panel: NotebookPanel, options: ContextOptions): number;
export declare function collectNotebookContext(panel: NotebookPanel, options: ContextOptions): NotebookContext;
export declare function editPolicyDescription(options: ContextOptions): string;
export declare function formatNotebookContext(context: NotebookContext): string;
export declare function buildAssistantPrompt(task: string, context: NotebookContext, options: ContextOptions, manualMode: boolean, userInstruction?: string): string;
