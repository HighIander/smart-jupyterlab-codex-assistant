import type { ServiceManager } from '@jupyterlab/services';
import { AgentRunResult, CodexReasoningEffort, CodexRunResult, CodexSpeed } from './types';
export interface CodexRunOptions {
    reasoningEffort: CodexReasoningEffort;
    speed: CodexSpeed;
}
export interface CodexAgentRunOptions extends CodexRunOptions {
    projectRoot: string;
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    additionalWriteDirectories: string[];
}
export declare class CodexRunner {
    private readonly services;
    constructor(services: ServiceManager.IManager);
    private session;
    private terminal;
    dispose(): Promise<void>;
    cancel(): Promise<void>;
    runAgent(prompt: string, options: CodexAgentRunOptions, onStatus: (message: string) => void): Promise<AgentRunResult>;
    private ensureSession;
    validatePythonSources(sources: Array<{
        label: string;
        source: string;
    }>, kernelName: string): Promise<void>;
    run(prompt: string, kernelName: string, options: CodexRunOptions, onStatus: (message: string) => void): Promise<CodexRunResult>;
}
