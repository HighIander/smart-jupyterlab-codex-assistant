export interface AssistantDirective {
    message: string;
    cleanedSource: string;
}
export declare function normalizeShortcut(value: string): string;
export declare function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean;
export declare function extractAssistantDirective(source: string): AssistantDirective | null;
