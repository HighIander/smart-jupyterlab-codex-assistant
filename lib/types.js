export const DEFAULT_CONTEXT_OPTIONS = {
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
export const DEFAULT_AGENT_PERMISSIONS = {
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
//# sourceMappingURL=types.js.map