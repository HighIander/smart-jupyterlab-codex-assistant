import { Dialog, MainAreaWidget, showDialog } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import { NotebookActions } from '@jupyterlab/notebook';
import { Widget } from '@lumino/widgets';
import { buildAssistantPrompt, collectNotebookContext, countNotebookContextCells, formatNotebookContext, sourceHash } from './context';
import { CodexRunner } from './codex';
import { extractAssistantDirective, normalizeShortcut } from './directive';
import { loadSettings, saveSettings } from './settings';
function button(label, className = 'jna-Button', title = '') {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.title = title;
    return element;
}
function sectionTitle(text) {
    const element = document.createElement('div');
    element.className = 'jna-SectionTitle';
    element.textContent = text;
    return element;
}
function formatSize(characters) {
    if (characters < 1024) {
        return `${characters} B`;
    }
    return `${(characters / 1024).toFixed(1)} kB`;
}
function decodeSourceTransportEscapes(source) {
    let result = '';
    let state = 'code';
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        const nextTwo = source.slice(index, index + 3);
        if ((state === 'code' || state === 'comment') &&
            character === '\\' &&
            next === 'n') {
            result += '\n';
            index += 1;
            state = 'code';
            continue;
        }
        if (state === 'comment') {
            result += character;
            continue;
        }
        if (state === 'code') {
            if (character === '#') {
                state = 'comment';
                result += character;
                continue;
            }
            if (nextTwo === "'''") {
                state = 'tripleSingle';
                result += nextTwo;
                index += 2;
                continue;
            }
            if (nextTwo === '"""') {
                state = 'tripleDouble';
                result += nextTwo;
                index += 2;
                continue;
            }
            if (character === "'") {
                state = 'single';
            }
            else if (character === '"') {
                state = 'double';
            }
            result += character;
            continue;
        }
        if (character === '\\' && index + 1 < source.length) {
            result += character + next;
            index += 1;
            continue;
        }
        if (state === 'single' && character === "'") {
            state = 'code';
        }
        else if (state === 'double' && character === '"') {
            state = 'code';
        }
        else if (state === 'tripleSingle' && nextTwo === "'''") {
            state = 'code';
            result += nextTwo;
            index += 2;
            continue;
        }
        else if (state === 'tripleDouble' && nextTwo === '"""') {
            state = 'code';
            result += nextTwo;
            index += 2;
            continue;
        }
        result += character;
    }
    return result;
}
function repairSourceFields(candidate) {
    const sourceKey = /"source"\s*:\s*"/g;
    let cursor = 0;
    let repaired = '';
    let match;
    while ((match = sourceKey.exec(candidate)) !== null) {
        const openingQuote = match.index + match[0].length - 1;
        const contentStart = openingQuote + 1;
        let closingQuote = -1;
        for (let index = contentStart; index < candidate.length; index += 1) {
            if (candidate[index] !== '"') {
                continue;
            }
            let lookahead = index + 1;
            while (/\s/.test(candidate[lookahead] ?? '')) {
                lookahead += 1;
            }
            if (candidate[lookahead] !== ',') {
                continue;
            }
            lookahead += 1;
            while (/\s/.test(candidate[lookahead] ?? '')) {
                lookahead += 1;
            }
            if (/^"reason"\s*:/.test(candidate.slice(lookahead))) {
                closingQuote = index;
                break;
            }
        }
        if (closingQuote < 0) {
            return candidate;
        }
        const rawSource = candidate.slice(contentStart, closingQuote);
        repaired += candidate.slice(cursor, openingQuote);
        repaired += JSON.stringify(decodeSourceTransportEscapes(rawSource));
        cursor = closingQuote + 1;
        sourceKey.lastIndex = cursor;
    }
    return repaired ? repaired + candidate.slice(cursor) : candidate;
}
function parsePatchCandidate(candidate) {
    try {
        return JSON.parse(candidate);
    }
    catch (strictError) {
        const repaired = repairSourceFields(candidate);
        try {
            return JSON.parse(repaired);
        }
        catch {
            throw strictError;
        }
    }
}
function patchFromText(text) {
    let candidate = text.trim();
    const tagMatch = candidate.match(/<jupyter_patch>\s*([\s\S]*?)\s*<\/jupyter_patch>/i);
    if (tagMatch) {
        candidate = tagMatch[1];
    }
    else {
        const jsonFence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (jsonFence) {
            candidate = jsonFence[1];
        }
        else {
            const first = candidate.indexOf('{');
            const last = candidate.lastIndexOf('}');
            if (first >= 0 && last > first) {
                candidate = candidate.slice(first, last + 1);
            }
        }
    }
    const parsed = parsePatchCandidate(candidate);
    if (typeof parsed.summary !== 'string' ||
        !Array.isArray(parsed.operations) ||
        !Array.isArray(parsed.notes)) {
        throw new Error('The pasted response does not match the notebook patch format.');
    }
    return parsed;
}
function sourcePreview(source, maxLength = 110) {
    const firstMeaningfulLine = source
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean);
    if (!firstMeaningfulLine) {
        return '(empty cell)';
    }
    const compact = firstMeaningfulLine.replace(/\s+/g, ' ');
    return compact.length > maxLength
        ? `${compact.slice(0, maxLength - 1)}…`
        : compact;
}
function cellDisplayReference(cellId, context, panel) {
    if (!cellId) {
        return {
            label: 'notebook end',
            metadata: '',
            preview: '',
            title: ''
        };
    }
    const snapshot = context.cells.find(cell => cell.id === cellId);
    const currentIndex = panel
        ? panel.content.widgets.findIndex(cell => cell.model.id === cellId)
        : -1;
    const currentCell = currentIndex >= 0 ? panel?.content.widgets[currentIndex] : null;
    const notebookIndex = snapshot?.index ?? currentIndex;
    const cellType = snapshot?.cellType ?? currentCell?.model.type ?? 'cell';
    const source = snapshot?.source ?? currentCell?.model.sharedModel.getSource() ?? '';
    const executionCount = snapshot?.executionCount ??
        (currentCell?.model
            ?.executionCount ?? null);
    const active = snapshot?.active ?? context.activeCellId === cellId;
    const selected = snapshot?.selected ?? context.selectedCellIds.includes(cellId);
    const metadata = [
        cellType,
        cellType === 'code' ? `In [${executionCount ?? ' '}]` : '',
        active ? 'active' : '',
        selected
            ? context.selectedCellIds.length > 1
                ? `selected ${context.selectedCellIds.indexOf(cellId) + 1} of ${context.selectedCellIds.length}`
                : 'selected'
            : ''
    ]
        .filter(Boolean)
        .join(' · ');
    return {
        label: notebookIndex >= 0 ? `Cell ${notebookIndex + 1}` : 'unknown cell',
        metadata,
        preview: sourcePreview(source),
        title: `Internal cell ID: ${cellId}`
    };
}
function operationLabel(operation, context, panel) {
    const target = cellDisplayReference(operation.cell_id, context, panel).label;
    const reference = cellDisplayReference(operation.reference_cell_id, context, panel).label;
    switch (operation.operation) {
        case 'replace':
            return `Replace ${target}`;
        case 'insert_before':
            return `Insert ${operation.cell_type} cell before ${target}`;
        case 'insert_after':
            return `Insert ${operation.cell_type} cell after ${target}`;
        case 'append':
            return `Append ${operation.cell_type} cell`;
        case 'delete':
            return `Delete ${target}`;
        case 'move_before':
            return `Move ${target} before ${reference}`;
        case 'move_after':
            return `Move ${target} after ${reference}`;
        default:
            return operation.operation;
    }
}
function appendCellReference(parent, role, reference) {
    if (!reference.metadata && !reference.preview) {
        return;
    }
    const row = document.createElement('div');
    row.className = 'jna-CellReference';
    row.title = reference.title;
    const heading = document.createElement('div');
    heading.className = 'jna-CellReferenceHeading';
    const roleNode = document.createElement('strong');
    roleNode.textContent = `${role}: `;
    const labelNode = document.createElement('span');
    labelNode.textContent = reference.label;
    const metadataNode = document.createElement('span');
    metadataNode.className = 'jna-CellReferenceMetadata';
    metadataNode.textContent = reference.metadata ? ` · ${reference.metadata}` : '';
    heading.append(roleNode, labelNode, metadataNode);
    const previewNode = document.createElement('code');
    previewNode.className = 'jna-CellReferencePreview';
    previewNode.textContent = reference.preview;
    row.append(heading, previewNode);
    parent.appendChild(row);
}
const CODEX_LOGIN_INSTRUCTIONS = [
    'Run these commands in a JupyterLab terminal to sign in to Codex and keep the login between JupyterLab sessions:',
    '',
    'export PATH="$HOME/.local/bin:$PATH"',
    'hash -r',
    'mkdir -p "$HOME/.codex"',
    'touch "$HOME/.codex/config.toml"',
    'emacs "$HOME/.codex/config.toml"',
    '',
    'Add this line, save the file, and exit Emacs:',
    'cli_auth_credentials_store = "file"',
    '',
    'Then run:',
    'codex login --device-auth',
    'codex login status'
].join('\n');
const PROJECT_README_URL = 'https://github.com/HighIander/jupyter-notebook-assistant#readme';
const PROJECT_LICENSE_URL = 'https://github.com/HighIander/jupyter-notebook-assistant/blob/main/LICENSE';
const AGENT_MODE_WARNING = 'Danger starts here. Change only settings you fully understand. ' +
    'Incorrect settings can cause permanent loss of any data accessible to your Jupyter server.';
function cloneAgentPermissions(permissions) {
    return { ...permissions };
}
function notebookDirectoryPath(panel) {
    const path = panel.context.path || '';
    const directory = PathExt.dirname(path);
    return directory && directory !== '.' ? directory : '.';
}
function normalizeFilesystemPath(path) {
    const absolute = path.startsWith('/');
    const parts = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            if (parts.length && parts[parts.length - 1] !== '..') {
                parts.pop();
            }
            else if (!absolute) {
                parts.push(part);
            }
            continue;
        }
        parts.push(part);
    }
    if (absolute) {
        return `/${parts.join('/')}` || '/';
    }
    return parts.join('/') || '.';
}
function resolveProjectRoot(panel, configuredRoot) {
    const trimmed = configuredRoot.trim() || './';
    if (trimmed.startsWith('/')) {
        return normalizeFilesystemPath(trimmed);
    }
    return normalizeFilesystemPath(PathExt.join(notebookDirectoryPath(panel), trimmed));
}
function parentDirectory(path, levels) {
    let result = path;
    for (let index = 0; index < levels; index += 1) {
        const absolute = result.startsWith('/');
        const normalized = normalizeFilesystemPath(result);
        const parts = normalized.split('/').filter(Boolean);
        if (parts.length) {
            parts.pop();
        }
        result = absolute ? `/${parts.join('/')}` || '/' : parts.join('/') || '.';
    }
    return result || '.';
}
function pathRelativeToProjectRoot(projectRoot, targetPath) {
    const projectIsAbsolute = projectRoot.startsWith('/');
    const targetIsAbsolute = targetPath.startsWith('/');
    if (projectIsAbsolute !== targetIsAbsolute) {
        return targetPath;
    }
    return PathExt.relative(projectRoot, targetPath) || '.';
}
function accessLabel(access) {
    if (access === 'write') {
        return 'write';
    }
    if (access === 'read') {
        return 'read';
    }
    return 'no access';
}
function splitDiffLines(source) {
    return source === '' ? [] : source.split('\n');
}
/**
 * Build a conventional line-oriented diff for notebook cell sources.
 *
 * A longest-common-subsequence alignment keeps unchanged lines as context and
 * marks only real additions/removals. Very large cells use a bounded fallback
 * so opening a history preview cannot allocate an excessive matrix.
 */
function calculateLineDiff(oldSource, newSource) {
    const oldLines = splitDiffLines(oldSource);
    const newLines = splitDiffLines(newSource);
    const matrixSize = oldLines.length * newLines.length;
    if (matrixSize > 500_000) {
        let prefixLength = 0;
        while (prefixLength < oldLines.length &&
            prefixLength < newLines.length &&
            oldLines[prefixLength] === newLines[prefixLength]) {
            prefixLength += 1;
        }
        let oldSuffixIndex = oldLines.length - 1;
        let newSuffixIndex = newLines.length - 1;
        while (oldSuffixIndex >= prefixLength &&
            newSuffixIndex >= prefixLength &&
            oldLines[oldSuffixIndex] === newLines[newSuffixIndex]) {
            oldSuffixIndex -= 1;
            newSuffixIndex -= 1;
        }
        return [
            ...oldLines.slice(0, prefixLength).map(text => ({ kind: 'context', text })),
            ...oldLines
                .slice(prefixLength, oldSuffixIndex + 1)
                .map(text => ({ kind: 'remove', text })),
            ...newLines
                .slice(prefixLength, newSuffixIndex + 1)
                .map(text => ({ kind: 'add', text })),
            ...oldLines
                .slice(oldSuffixIndex + 1)
                .map(text => ({ kind: 'context', text }))
        ];
    }
    const lengths = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
            lengths[oldIndex][newIndex] =
                oldLines[oldIndex] === newLines[newIndex]
                    ? lengths[oldIndex + 1][newIndex + 1] + 1
                    : Math.max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1]);
        }
    }
    const result = [];
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        if (oldLines[oldIndex] === newLines[newIndex]) {
            result.push({ kind: 'context', text: oldLines[oldIndex] });
            oldIndex += 1;
            newIndex += 1;
        }
        else if (lengths[oldIndex + 1][newIndex] >= lengths[oldIndex][newIndex + 1]) {
            result.push({ kind: 'remove', text: oldLines[oldIndex] });
            oldIndex += 1;
        }
        else {
            result.push({ kind: 'add', text: newLines[newIndex] });
            newIndex += 1;
        }
    }
    while (oldIndex < oldLines.length) {
        result.push({ kind: 'remove', text: oldLines[oldIndex] });
        oldIndex += 1;
    }
    while (newIndex < newLines.length) {
        result.push({ kind: 'add', text: newLines[newIndex] });
        newIndex += 1;
    }
    return result;
}
function lineDiff(oldSource, newSource) {
    const root = document.createElement('pre');
    root.className = 'jna-Diff';
    root.setAttribute('aria-label', 'Notebook source diff');
    for (const entry of calculateLineDiff(oldSource, newSource)) {
        const line = document.createElement('span');
        line.className =
            entry.kind === 'add'
                ? 'jna-DiffAdd'
                : entry.kind === 'remove'
                    ? 'jna-DiffRemove'
                    : 'jna-DiffContext';
        const marker = entry.kind === 'add' ? '+' : entry.kind === 'remove' ? '-' : ' ';
        line.textContent = `${marker} ${entry.text}\n`;
        root.appendChild(line);
    }
    return root;
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function readNotebookSnapshot(value) {
    if (value === null ||
        typeof value !== 'object' ||
        !Array.isArray(value.cells)) {
        throw new Error('The stored notebook snapshot is invalid.');
    }
    return value;
}
function snapshotCellId(cell) {
    return typeof cell.id === 'string' ? cell.id : '';
}
function snapshotCellSource(cell) {
    if (Array.isArray(cell.source)) {
        return cell.source.join('');
    }
    return typeof cell.source === 'string' ? cell.source : '';
}
function setSnapshotCellSource(cell, source) {
    cell.source = source;
}
function snapshotCellWithoutSource(cell) {
    const comparable = cloneJson(cell);
    delete comparable.id;
    delete comparable.source;
    return JSON.stringify(comparable);
}
function snapshotWithoutCells(snapshot) {
    const comparable = cloneJson(snapshot);
    delete comparable.cells;
    return JSON.stringify(comparable);
}
function longestCommonSubsequence(first, second) {
    const lengths = Array.from({ length: first.length + 1 }, () => Array(second.length + 1).fill(0));
    for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
        for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
            lengths[firstIndex][secondIndex] =
                first[firstIndex - 1] === second[secondIndex - 1]
                    ? lengths[firstIndex - 1][secondIndex - 1] + 1
                    : Math.max(lengths[firstIndex - 1][secondIndex], lengths[firstIndex][secondIndex - 1]);
        }
    }
    const stableIds = new Set();
    let firstIndex = first.length;
    let secondIndex = second.length;
    while (firstIndex > 0 && secondIndex > 0) {
        if (first[firstIndex - 1] === second[secondIndex - 1]) {
            stableIds.add(first[firstIndex - 1]);
            firstIndex -= 1;
            secondIndex -= 1;
        }
        else if (lengths[firstIndex - 1][secondIndex] >=
            lengths[firstIndex][secondIndex - 1]) {
            firstIndex -= 1;
        }
        else {
            secondIndex -= 1;
        }
    }
    return stableIds;
}
function insertSnapshotCellByTargetOrder(cells, cell, targetOrder) {
    const id = snapshotCellId(cell);
    const targetIndex = targetOrder.indexOf(id);
    const existingIndex = cells.findIndex(candidate => snapshotCellId(candidate) === id);
    if (existingIndex >= 0) {
        cells.splice(existingIndex, 1);
    }
    for (let index = targetIndex + 1; index < targetOrder.length; index += 1) {
        const nextIndex = cells.findIndex(candidate => snapshotCellId(candidate) === targetOrder[index]);
        if (nextIndex >= 0) {
            cells.splice(nextIndex, 0, cell);
            return;
        }
    }
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
        const previousIndex = cells.findIndex(candidate => snapshotCellId(candidate) === targetOrder[index]);
        if (previousIndex >= 0) {
            cells.splice(previousIndex + 1, 0, cell);
            return;
        }
    }
    cells.push(cell);
}
function makeSnapshotCell(operation, id) {
    if (operation.cell_type === 'markdown') {
        return {
            id,
            cell_type: 'markdown',
            source: operation.source,
            metadata: {}
        };
    }
    return {
        id,
        cell_type: 'code',
        source: operation.source,
        metadata: {},
        outputs: [],
        execution_count: null
    };
}
/**
 * Predict the notebook state produced by applying a stored patch to the
 * current snapshot. The generated cell IDs are preview-only placeholders;
 * the real apply path still performs permission, source-hash, and syntax
 * validation before mutating the notebook.
 */
function simulatePatchOnSnapshot(currentValue, patch, selectedOperationIndexes, previewIdPrefix) {
    const result = readNotebookSnapshot(cloneJson(currentValue));
    const cells = result.cells;
    for (const operationIndex of selectedOperationIndexes) {
        const operation = patch.operations[operationIndex];
        if (!operation) {
            throw new Error(`Patch operation ${operationIndex + 1} no longer exists.`);
        }
        const sourceIndex = operation.cell_id
            ? cells.findIndex(cell => snapshotCellId(cell) === operation.cell_id)
            : -1;
        if (operation.operation === 'replace') {
            if (sourceIndex < 0) {
                throw new Error(`The target of operation ${operationIndex + 1} no longer exists.`);
            }
            setSnapshotCellSource(cells[sourceIndex], operation.source);
            continue;
        }
        if (operation.operation === 'insert_before' ||
            operation.operation === 'insert_after') {
            if (sourceIndex < 0) {
                throw new Error(`The anchor of operation ${operationIndex + 1} no longer exists.`);
            }
            let insertedId = `${previewIdPrefix}-${operationIndex + 1}`;
            let suffix = 1;
            while (cells.some(cell => snapshotCellId(cell) === insertedId)) {
                insertedId = `${previewIdPrefix}-${operationIndex + 1}-${suffix}`;
                suffix += 1;
            }
            const destination = operation.operation === 'insert_before' ? sourceIndex : sourceIndex + 1;
            cells.splice(destination, 0, makeSnapshotCell(operation, insertedId));
            continue;
        }
        if (operation.operation === 'append') {
            let insertedId = `${previewIdPrefix}-${operationIndex + 1}`;
            let suffix = 1;
            while (cells.some(cell => snapshotCellId(cell) === insertedId)) {
                insertedId = `${previewIdPrefix}-${operationIndex + 1}-${suffix}`;
                suffix += 1;
            }
            cells.push(makeSnapshotCell(operation, insertedId));
            continue;
        }
        if (operation.operation === 'delete') {
            if (sourceIndex < 0) {
                throw new Error(`The target of operation ${operationIndex + 1} no longer exists.`);
            }
            cells.splice(sourceIndex, 1);
            continue;
        }
        if (operation.operation === 'move_before' ||
            operation.operation === 'move_after') {
            if (sourceIndex < 0) {
                throw new Error(`The source of operation ${operationIndex + 1} no longer exists.`);
            }
            const referenceIndex = cells.findIndex(cell => snapshotCellId(cell) === operation.reference_cell_id);
            if (referenceIndex < 0) {
                throw new Error(`The destination anchor of operation ${operationIndex + 1} no longer exists.`);
            }
            const [movedCell] = cells.splice(sourceIndex, 1);
            const adjustedReferenceIndex = cells.findIndex(cell => snapshotCellId(cell) === operation.reference_cell_id);
            const destination = operation.operation === 'move_before'
                ? adjustedReferenceIndex
                : adjustedReferenceIndex + 1;
            cells.splice(destination, 0, movedCell);
        }
    }
    return result;
}
/**
 * Replay only the cell-level delta between two recorded notebook snapshots on
 * top of the current notebook. Unrelated current cells, outputs, and metadata
 * are preserved. Sources of cells touched by the patch and structural cell
 * operations are deliberately replayed and may conflict with later edits.
 */
function replaySnapshotDelta(currentValue, sourceValue, targetValue) {
    const result = readNotebookSnapshot(cloneJson(currentValue));
    const source = readNotebookSnapshot(sourceValue);
    const target = readNotebookSnapshot(targetValue);
    const cells = result.cells;
    const sourceIds = source.cells.map(snapshotCellId);
    const targetIds = target.cells.map(snapshotCellId);
    const sourceIdSet = new Set(sourceIds);
    const targetIdSet = new Set(targetIds);
    const sourceById = new Map(source.cells.map(cell => [snapshotCellId(cell), cell]));
    const targetById = new Map(target.cells.map(cell => [snapshotCellId(cell), cell]));
    for (const id of sourceIds.filter(candidate => !targetIdSet.has(candidate))) {
        const index = cells.findIndex(cell => snapshotCellId(cell) === id);
        if (index >= 0) {
            cells.splice(index, 1);
        }
    }
    for (const id of targetIds.filter(candidate => sourceIdSet.has(candidate))) {
        const sourceCell = sourceById.get(id);
        const targetCell = targetById.get(id);
        if (!sourceCell || !targetCell) {
            continue;
        }
        if (snapshotCellSource(sourceCell) === snapshotCellSource(targetCell)) {
            continue;
        }
        const currentCell = cells.find(cell => snapshotCellId(cell) === id);
        if (!currentCell) {
            throw new Error(`A cell changed by the recorded patch (${id}) no longer exists in the current notebook.`);
        }
        setSnapshotCellSource(currentCell, snapshotCellSource(targetCell));
    }
    for (const id of targetIds.filter(candidate => !sourceIdSet.has(candidate))) {
        const targetCell = targetById.get(id);
        if (!targetCell) {
            continue;
        }
        const existingCell = cells.find(cell => snapshotCellId(cell) === id);
        const replayCell = existingCell ?? cloneJson(targetCell);
        if (existingCell) {
            setSnapshotCellSource(existingCell, snapshotCellSource(targetCell));
        }
        insertSnapshotCellByTargetOrder(cells, replayCell, targetIds);
    }
    const commonSourceOrder = sourceIds.filter(id => targetIdSet.has(id));
    const commonTargetOrder = targetIds.filter(id => sourceIdSet.has(id));
    const stableIds = longestCommonSubsequence(commonSourceOrder, commonTargetOrder);
    for (const id of commonTargetOrder.filter(candidate => !stableIds.has(candidate))) {
        const currentCell = cells.find(cell => snapshotCellId(cell) === id);
        if (!currentCell) {
            throw new Error(`A moved cell from the recorded patch (${id}) no longer exists in the current notebook.`);
        }
        insertSnapshotCellByTargetOrder(cells, currentCell, targetIds);
    }
    return result;
}
function notebookSnapshotFingerprint(snapshot) {
    return JSON.stringify(snapshot);
}
function notebookSnapshotDiff(beforeValue, afterValue) {
    const before = readNotebookSnapshot(beforeValue);
    const after = readNotebookSnapshot(afterValue);
    const root = document.createElement('div');
    root.className = 'jna-HistoryPreviewChanges';
    const beforeIds = before.cells.map(snapshotCellId);
    const afterIds = after.cells.map(snapshotCellId);
    const beforeIdSet = new Set(beforeIds);
    const afterIdSet = new Set(afterIds);
    const beforeById = new Map(before.cells.map((cell, index) => [snapshotCellId(cell), { cell, index }]));
    const afterById = new Map(after.cells.map((cell, index) => [snapshotCellId(cell), { cell, index }]));
    let changeCount = 0;
    const appendChange = (headingText, oldSource, newSource, note) => {
        changeCount += 1;
        const change = document.createElement('div');
        change.className = 'jna-HistoryPreviewChange';
        const heading = document.createElement('div');
        heading.className = 'jna-HistoryPreviewChangeTitle';
        heading.textContent = headingText;
        change.appendChild(heading);
        if (note) {
            const detail = document.createElement('div');
            detail.className = 'jna-HistoryPreviewChangeNote';
            detail.textContent = note;
            change.appendChild(detail);
        }
        if (oldSource !== undefined || newSource !== undefined) {
            change.appendChild(lineDiff(oldSource ?? '', newSource ?? ''));
        }
        root.appendChild(change);
    };
    for (const id of beforeIds.filter(candidate => !afterIdSet.has(candidate))) {
        const beforeEntry = beforeById.get(id);
        if (!beforeEntry) {
            continue;
        }
        appendChange(`Remove current Cell ${beforeEntry.index + 1}`, snapshotCellSource(beforeEntry.cell), '');
    }
    for (const id of afterIds.filter(candidate => !beforeIdSet.has(candidate))) {
        const afterEntry = afterById.get(id);
        if (!afterEntry) {
            continue;
        }
        appendChange(`Add result Cell ${afterEntry.index + 1} (${afterEntry.cell.cell_type ?? 'cell'})`, '', snapshotCellSource(afterEntry.cell));
    }
    for (const id of beforeIds.filter(candidate => afterIdSet.has(candidate))) {
        const beforeEntry = beforeById.get(id);
        const afterEntry = afterById.get(id);
        if (!beforeEntry || !afterEntry) {
            continue;
        }
        const oldSource = snapshotCellSource(beforeEntry.cell);
        const newSource = snapshotCellSource(afterEntry.cell);
        if (oldSource !== newSource) {
            appendChange(beforeEntry.index === afterEntry.index
                ? `Modify Cell ${beforeEntry.index + 1}`
                : `Modify current Cell ${beforeEntry.index + 1} → result Cell ${afterEntry.index + 1}`, oldSource, newSource);
        }
        if (snapshotCellWithoutSource(beforeEntry.cell) !==
            snapshotCellWithoutSource(afterEntry.cell)) {
            appendChange(`Restore non-source data of Cell ${afterEntry.index + 1}`, undefined, undefined, 'Outputs, execution count, attachments, or cell metadata differ.');
        }
    }
    const commonBeforeOrder = beforeIds.filter(id => afterIdSet.has(id));
    const commonAfterOrder = afterIds.filter(id => beforeIdSet.has(id));
    const stableIds = longestCommonSubsequence(commonBeforeOrder, commonAfterOrder);
    for (const id of commonAfterOrder.filter(candidate => !stableIds.has(candidate))) {
        const beforeEntry = beforeById.get(id);
        const afterEntry = afterById.get(id);
        if (!beforeEntry || !afterEntry) {
            continue;
        }
        appendChange(`Move Cell ${beforeEntry.index + 1} → position ${afterEntry.index + 1}`);
    }
    if (snapshotWithoutCells(before) !== snapshotWithoutCells(after)) {
        appendChange('Restore notebook-level metadata', undefined, undefined, 'Notebook metadata or format fields differ.');
    }
    if (changeCount === 0) {
        const empty = document.createElement('div');
        empty.className = 'jna-HistoryPreviewEmpty';
        empty.textContent = 'This action would not change the current notebook.';
        root.appendChild(empty);
    }
    return root;
}
export class SessionHistoryStore {
    entries = [];
    listeners = new Set();
    nextId = 1;
    conversationNumber = 1;
    messageNumber = 0;
    undoLimit = 20;
    getEntries() {
        return this.entries.slice();
    }
    nextMessagePosition() {
        this.messageNumber += 1;
        return {
            conversationNumber: this.conversationNumber,
            messageNumber: this.messageNumber
        };
    }
    startNewConversation() {
        this.conversationNumber += 1;
        this.messageNumber = 0;
    }
    setUndoLimit(limit) {
        this.undoLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
        this.trimUndoSnapshots();
        this.emit();
    }
    add(entry) {
        const stored = {
            ...cloneJson(entry),
            id: this.nextId
        };
        this.nextId += 1;
        this.entries.push(stored);
        this.trimUndoSnapshots();
        this.emit();
        return stored;
    }
    update(id, changes) {
        const index = this.entries.findIndex(entry => entry.id === id);
        if (index < 0) {
            return;
        }
        this.entries[index] = {
            ...this.entries[index],
            ...cloneJson(changes)
        };
        this.trimUndoSnapshots();
        this.emit();
    }
    trimUndoSnapshots() {
        const entriesWithUndoData = this.entries.filter(entry => entry.beforeSnapshot !== null || entry.afterSnapshot !== null);
        const discardCount = Math.max(0, entriesWithUndoData.length - this.undoLimit);
        for (const entry of entriesWithUndoData.slice(0, discardCount)) {
            entry.beforeSnapshot = null;
            entry.afterSnapshot = null;
        }
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit() {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
export class AssistantContent extends Widget {
    tracker;
    requestActivation;
    historyStore;
    requestHistoryOpen;
    constructor(tracker, services, requestActivation, historyStore = new SessionHistoryStore(), requestHistoryOpen) {
        super();
        this.tracker = tracker;
        this.requestActivation = requestActivation;
        this.historyStore = historyStore;
        this.requestHistoryOpen = requestHistoryOpen;
        this.addClass('jna-AssistantRoot');
        const settings = loadSettings();
        this.mode = settings.mode;
        this.workingMode = settings.workingMode;
        this.agentPermissions = cloneAgentPermissions(settings.agentPermissions);
        this.loginInstructionsShown = settings.loginInstructionsShown;
        this.contextOptions = settings.contextOptions;
        this.assistantShortcut = settings.assistantShortcut;
        this.selectAboveShortcut = settings.selectAboveShortcut;
        this.codexReasoningEffort = settings.codexReasoningEffort;
        this.codexSpeed = settings.codexSpeed;
        this.autoApplyAfterParseSetting = settings.autoApplyAfterParse;
        this.codexAutoApplySetting = settings.codexAutoApply;
        this.autoRunOnApplySetting = settings.autoRunOnApply;
        this.userInstruction = settings.userInstruction;
        this.includeUserInstruction = settings.includeUserInstruction;
        this.enterSubmits = settings.enterSubmits;
        this.undoHistoryLimit = settings.undoHistoryLimit;
        this.historyStore.setUndoLimit(this.undoHistoryLimit);
        this.codexRunner = new CodexRunner(services);
        this.buildUI();
        this.historyUnsubscribe = this.historyStore.subscribe(() => this.syncCurrentHistoryState());
        this.updateModeUI();
        this.updateWorkingModeUI();
        this.tracker.currentChanged.connect(this.onNotebookTargetChanged, this);
        this.tracker.activeCellChanged.connect(this.onNotebookTargetChanged, this);
        this.tracker.selectionChanged.connect(this.onNotebookTargetChanged, this);
        this.refreshNotebookStatus();
        if (!this.loginInstructionsShown) {
            this.loginInstructionsShown = true;
            this.persistSettings();
            window.setTimeout(() => {
                if (!this.isDisposed) {
                    void this.openCodexLoginDialog();
                }
            }, 250);
        }
    }
    mode;
    workingMode;
    agentPermissions;
    loginInstructionsShown;
    contextOptions;
    assistantShortcut;
    selectAboveShortcut;
    codexReasoningEffort;
    codexSpeed;
    autoApplyAfterParseSetting;
    codexAutoApplySetting;
    autoRunOnApplySetting;
    userInstruction;
    includeUserInstruction;
    enterSubmits;
    undoHistoryLimit;
    codexRunner;
    statusFrame = 0;
    statusDirty = false;
    currentPatch = null;
    patchContext = null;
    patchOptions = null;
    pendingManualContext = null;
    pendingManualOptions = null;
    operationChecks = [];
    undoSnapshot = null;
    busy = false;
    detailsCollapsed = false;
    patchApplied = false;
    currentHistoryEntryId = null;
    historyUnsubscribe = null;
    feedbackTimers = new Map();
    successBannerTimer = null;
    generateLockedUntilInput = false;
    contentNode;
    agentBanner;
    successBanner;
    modeCodexButton;
    modeChatGPTButton;
    newConversationButton;
    loginButton;
    settingsDetails;
    taskInput;
    codexOptions;
    reasoningSelect;
    speedSelect;
    contextButton;
    agentModeButton;
    agentModeToggle;
    codexActions;
    chatGPTActions;
    generateButton;
    cancelButton;
    workingLabel;
    openChatGPTButton;
    copyPromptButton;
    responseInput;
    parseButton;
    autoParseAfterPaste;
    autoApplyAfterParse;
    codexAutoApply;
    manualAutoApplyLine;
    codexAutoApplyLine;
    autoRunOnApply;
    resultSection;
    resultNode;
    patchDetailsNode = null;
    detailsToggleButton;
    statusMessage;
    targetStatus;
    processStatus;
    historyButton;
    applyButton;
    rejectButton;
    undoButton;
    patchActionRow;
    dispose() {
        this.historyUnsubscribe?.();
        this.historyUnsubscribe = null;
        this.tracker.currentChanged.disconnect(this.onNotebookTargetChanged, this);
        this.tracker.activeCellChanged.disconnect(this.onNotebookTargetChanged, this);
        this.tracker.selectionChanged.disconnect(this.onNotebookTargetChanged, this);
        if (this.statusFrame) {
            window.cancelAnimationFrame(this.statusFrame);
            this.statusFrame = 0;
        }
        for (const timer of this.feedbackTimers.values()) {
            window.clearTimeout(timer);
        }
        this.feedbackTimers.clear();
        if (this.successBannerTimer !== null) {
            window.clearTimeout(this.successBannerTimer);
            this.successBannerTimer = null;
        }
        void this.codexRunner.dispose();
        super.dispose();
    }
    get panel() {
        return this.tracker.currentWidget;
    }
    persistSettings() {
        saveSettings({
            mode: this.mode,
            workingMode: this.workingMode,
            agentPermissions: cloneAgentPermissions(this.agentPermissions),
            loginInstructionsShown: this.loginInstructionsShown,
            contextOptions: this.contextOptions,
            assistantShortcut: this.assistantShortcut,
            selectAboveShortcut: this.selectAboveShortcut,
            codexReasoningEffort: this.codexReasoningEffort,
            codexSpeed: this.codexSpeed,
            autoApplyAfterParse: this.autoApplyAfterParseSetting,
            codexAutoApply: this.codexAutoApplySetting,
            autoRunOnApply: this.autoRunOnApplySetting,
            userInstruction: this.userInstruction,
            includeUserInstruction: this.includeUserInstruction,
            enterSubmits: this.enterSubmits,
            undoHistoryLimit: this.undoHistoryLimit
        });
    }
    buildUI() {
        const header = document.createElement('div');
        header.className = 'jna-Header';
        const headerTop = document.createElement('div');
        headerTop.className = 'jna-HeaderTop';
        const headerText = document.createElement('div');
        headerText.className = 'jna-HeaderText';
        const title = document.createElement('div');
        title.className = 'jna-HeaderTitle';
        title.textContent = 'Jupyter Assistant';
        const subtitle = document.createElement('div');
        subtitle.className = 'jna-HeaderSubline';
        subtitle.textContent = 'Notebook-aware Codex and manual ChatGPT workflow';
        headerText.append(title, subtitle);
        const headerActions = document.createElement('div');
        headerActions.className = 'jna-HeaderActions';
        this.loginButton = button('Log in', 'jna-HeaderLoginButton');
        this.loginButton.title = 'Show Codex login instructions';
        this.loginButton.setAttribute('aria-label', 'Show Codex login instructions');
        this.loginButton.onclick = () => void this.openCodexLoginDialog();
        // Use a native details element as an extensible settings menu. Additional
        // settings can be appended to the menu without changing the header layout.
        this.settingsDetails = document.createElement('details');
        this.settingsDetails.className = 'jna-SettingsDetails';
        const settingsSummary = document.createElement('summary');
        settingsSummary.className = 'jna-SettingsButton';
        settingsSummary.textContent = '⚙';
        settingsSummary.title = 'Assistant settings';
        settingsSummary.setAttribute('aria-label', 'Assistant settings');
        const settingsMenu = document.createElement('div');
        settingsMenu.className = 'jna-SettingsMenu';
        const settingsTitle = document.createElement('div');
        settingsTitle.className = 'jna-SettingsMenuTitle';
        settingsTitle.textContent = 'Input behavior';
        const radioName = 'jna-submit-key-mode';
        const enterSubmitLine = document.createElement('label');
        enterSubmitLine.className = 'jna-SettingsOption';
        const enterSubmitRadio = document.createElement('input');
        enterSubmitRadio.type = 'radio';
        enterSubmitRadio.name = radioName;
        enterSubmitRadio.checked = this.enterSubmits;
        enterSubmitRadio.onchange = () => {
            if (enterSubmitRadio.checked) {
                this.enterSubmits = true;
                this.persistSettings();
            }
        };
        enterSubmitLine.append(enterSubmitRadio, document.createTextNode('Enter submits; Shift+Enter inserts a new line'));
        const shiftEnterSubmitLine = document.createElement('label');
        shiftEnterSubmitLine.className = 'jna-SettingsOption';
        const shiftEnterSubmitRadio = document.createElement('input');
        shiftEnterSubmitRadio.type = 'radio';
        shiftEnterSubmitRadio.name = radioName;
        shiftEnterSubmitRadio.checked = !this.enterSubmits;
        shiftEnterSubmitRadio.onchange = () => {
            if (shiftEnterSubmitRadio.checked) {
                this.enterSubmits = false;
                this.persistSettings();
            }
        };
        shiftEnterSubmitLine.append(shiftEnterSubmitRadio, document.createTextNode('Shift+Enter submits; Enter inserts a new line'));
        const promptSettingsTitle = document.createElement('div');
        promptSettingsTitle.className = 'jna-SettingsMenuTitle jna-SettingsMenuTitleSpaced';
        promptSettingsTitle.textContent = 'Prompt';
        const userInstructionsButton = button('User instructions…', 'jna-SettingsMenuAction');
        userInstructionsButton.onclick = () => {
            this.settingsDetails.open = false;
            void this.openUserInstructionsDialog();
        };
        const projectSettingsTitle = document.createElement('div');
        projectSettingsTitle.className = 'jna-SettingsMenuTitle jna-SettingsMenuTitleSpaced';
        projectSettingsTitle.textContent = 'Project';
        const readmeLink = document.createElement('a');
        readmeLink.className = 'jna-SettingsMenuAction';
        readmeLink.textContent = 'README / documentation';
        readmeLink.href = PROJECT_README_URL;
        readmeLink.target = '_blank';
        readmeLink.rel = 'noopener noreferrer';
        readmeLink.onclick = () => {
            this.settingsDetails.open = false;
        };
        const licenseLink = document.createElement('a');
        licenseLink.className = 'jna-SettingsMenuAction jna-SettingsMenuActionSpaced';
        licenseLink.textContent = 'License (AGPL-3.0)';
        licenseLink.href = PROJECT_LICENSE_URL;
        licenseLink.target = '_blank';
        licenseLink.rel = 'noopener noreferrer';
        licenseLink.onclick = () => {
            this.settingsDetails.open = false;
        };
        const historySettingsTitle = document.createElement('div');
        historySettingsTitle.className = 'jna-SettingsMenuTitle jna-SettingsMenuTitleSpaced';
        historySettingsTitle.textContent = 'History';
        const undoLimitLine = document.createElement('label');
        undoLimitLine.className = 'jna-SettingsNumberOption';
        const undoLimitText = document.createElement('span');
        undoLimitText.textContent = 'Stored undo steps';
        const undoLimitInput = document.createElement('input');
        undoLimitInput.type = 'number';
        undoLimitInput.min = '1';
        undoLimitInput.max = '100';
        undoLimitInput.step = '1';
        undoLimitInput.value = String(this.undoHistoryLimit);
        undoLimitInput.setAttribute('aria-label', 'Number of stored undo steps');
        const commitUndoLimit = () => {
            const parsed = Number(undoLimitInput.value);
            const normalized = Number.isFinite(parsed)
                ? Math.max(1, Math.min(100, Math.trunc(parsed)))
                : this.undoHistoryLimit;
            undoLimitInput.value = String(normalized);
            this.undoHistoryLimit = normalized;
            this.historyStore.setUndoLimit(normalized);
            this.persistSettings();
        };
        undoLimitInput.onchange = commitUndoLimit;
        undoLimitInput.onblur = commitUndoLimit;
        undoLimitLine.append(undoLimitText, undoLimitInput);
        const undoLimitHelp = document.createElement('div');
        undoLimitHelp.className = 'jna-SettingsHelp';
        undoLimitHelp.textContent =
            'Patch entries remain visible, but notebook snapshots older than this limit are discarded. Increasing the limit later cannot restore discarded snapshots.';
        settingsMenu.append(settingsTitle, enterSubmitLine, shiftEnterSubmitLine, promptSettingsTitle, userInstructionsButton, projectSettingsTitle, readmeLink, licenseLink, historySettingsTitle, undoLimitLine, undoLimitHelp);
        this.settingsDetails.append(settingsSummary, settingsMenu);
        headerActions.append(this.loginButton, this.settingsDetails);
        headerTop.append(headerText, headerActions);
        header.append(headerTop);
        this.agentBanner = document.createElement('div');
        this.agentBanner.className = 'jna-AgentBanner';
        this.agentBanner.textContent = 'Agent mode active';
        this.agentBanner.setAttribute('role', 'alert');
        this.agentBanner.hidden = this.workingMode !== 'agent';
        this.contentNode = document.createElement('div');
        this.contentNode.className = 'jna-Content';
        // Keep successful patch feedback visible at the top after the result pane is cleared.
        this.successBanner = document.createElement('div');
        this.successBanner.className = 'jna-SuccessBanner';
        this.successBanner.textContent = 'patch successfully applied';
        this.successBanner.setAttribute('role', 'status');
        this.successBanner.setAttribute('aria-live', 'polite');
        this.successBanner.hidden = true;
        const modeSection = document.createElement('div');
        modeSection.className = 'jna-Section';
        modeSection.appendChild(sectionTitle('Mode'));
        const modeBar = document.createElement('div');
        modeBar.className = 'jna-ModeBar';
        this.modeCodexButton = button('Codex workflow', 'jna-ModeButton');
        this.modeChatGPTButton = button('ChatGPT manual', 'jna-ModeButton');
        this.modeCodexButton.onclick = () => this.setMode('codex');
        this.modeChatGPTButton.onclick = () => this.setMode('chatgpt');
        modeBar.append(this.modeCodexButton, this.modeChatGPTButton);
        modeSection.appendChild(modeBar);
        const taskSection = document.createElement('div');
        taskSection.className = 'jna-Section';
        const taskHeader = document.createElement('div');
        taskHeader.className = 'jna-TaskHeader';
        taskHeader.appendChild(sectionTitle('Task'));
        this.newConversationButton = button('New conversation', 'jna-SmallButton');
        this.newConversationButton.onclick = () => this.resetConversation();
        taskHeader.appendChild(this.newConversationButton);
        taskSection.appendChild(taskHeader);
        this.taskInput = document.createElement('textarea');
        this.taskInput.className = 'jna-TaskInput';
        this.taskInput.placeholder =
            'Describe the change, correction, analysis, or new cell you need…';
        this.taskInput.addEventListener('input', () => {
            // A changed request unlocks patch generation after the previous result.
            this.generateLockedUntilInput = false;
            this.updateGenerateButtonState();
            this.resetAppliedButtonForEditing();
            this.updateManualTaskState();
        });
        this.taskInput.addEventListener('keydown', event => {
            const noSelection = this.taskInput.selectionStart === this.taskInput.selectionEnd;
            if (this.shouldSubmitFromInput(event)) {
                event.preventDefault();
                event.stopPropagation();
                this.runTaskFieldPrimaryAction();
                return;
            }
            if (this.mode === 'chatgpt' &&
                event.ctrlKey &&
                !event.altKey &&
                !event.shiftKey &&
                !event.metaKey &&
                event.key.toLowerCase() === 'c' &&
                noSelection) {
                event.preventDefault();
                event.stopPropagation();
                void this.copyPrompt();
            }
        });
        taskSection.appendChild(this.taskInput);
        this.codexOptions = document.createElement('div');
        this.codexOptions.className = 'jna-CodexOptions';
        const reasoningLabel = document.createElement('label');
        reasoningLabel.className = 'jna-SelectLabel';
        reasoningLabel.appendChild(document.createTextNode('Reasoning effort'));
        this.reasoningSelect = document.createElement('select');
        this.reasoningSelect.className = 'jna-Select';
        const reasoningOptions = [
            ['low', 'Low'],
            ['medium', 'Medium'],
            ['high', 'High'],
            ['xhigh', 'Extra high']
        ];
        for (const [value, label] of reasoningOptions) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            this.reasoningSelect.appendChild(option);
        }
        this.reasoningSelect.value = this.codexReasoningEffort;
        this.reasoningSelect.onchange = () => {
            this.codexReasoningEffort = this.reasoningSelect
                .value;
            this.persistSettings();
        };
        reasoningLabel.appendChild(this.reasoningSelect);
        const speedLabel = document.createElement('label');
        speedLabel.className = 'jna-SelectLabel';
        speedLabel.appendChild(document.createTextNode('Mode'));
        this.speedSelect = document.createElement('select');
        this.speedSelect.className = 'jna-Select';
        for (const [value, label] of [
            ['normal', 'Normal'],
            ['fast', 'Fast']
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            this.speedSelect.appendChild(option);
        }
        this.speedSelect.value = this.codexSpeed;
        this.speedSelect.onchange = () => {
            this.codexSpeed = this.speedSelect.value;
            this.persistSettings();
        };
        speedLabel.appendChild(this.speedSelect);
        this.codexOptions.append(reasoningLabel, speedLabel);
        taskSection.appendChild(this.codexOptions);
        this.contextButton = button('', 'jna-ContextButton');
        this.contextButton.onclick = () => void this.openContextDialog();
        const permissionButtonRow = document.createElement('div');
        permissionButtonRow.className = 'jna-PermissionButtonRow';
        permissionButtonRow.appendChild(this.contextButton);
        const agentControl = document.createElement('div');
        agentControl.className = 'jna-AgentControl';
        this.agentModeButton = button('Agent mode', 'jna-AgentModeLabel');
        this.agentModeButton.onclick = () => void this.openAgentModeDialog();
        this.agentModeToggle = button('', 'jna-ToggleButton', 'Toggle agent mode');
        this.agentModeToggle.setAttribute('role', 'switch');
        this.agentModeToggle.onclick = event => {
            event.stopPropagation();
            void this.toggleAgentMode();
        };
        agentControl.append(this.agentModeButton, this.agentModeToggle);
        permissionButtonRow.appendChild(agentControl);
        taskSection.appendChild(permissionButtonRow);
        this.codexActions = document.createElement('div');
        this.codexActions.className = 'jna-CodexActions';
        this.codexActions.style.marginTop = '8px';
        const codexButtonRow = document.createElement('div');
        codexButtonRow.className = 'jna-ButtonRow';
        this.generateButton = button('Generate patch', 'jna-Button jp-mod-accept');
        this.cancelButton = button('Cancel', 'jna-Button jp-mod-warn');
        this.cancelButton.hidden = true;
        this.generateButton.onclick = () => void this.generateCodexPatch();
        this.cancelButton.onclick = () => void this.cancelCodex();
        codexButtonRow.append(this.cancelButton, this.generateButton);
        // Warn the user while Codex is resolving notebook cells and source hashes.
        // Editing the notebook during this interval can invalidate the generated patch.
        this.workingLabel = document.createElement('div');
        this.workingLabel.className = 'jna-WorkingLabel';
        this.workingLabel.textContent =
            'Working... do not modify the notebook now.';
        this.workingLabel.setAttribute('role', 'status');
        this.workingLabel.setAttribute('aria-live', 'polite');
        this.workingLabel.hidden = true;
        this.codexAutoApplyLine = document.createElement('label');
        this.codexAutoApplyLine.className =
            'jna-OptionLine jna-WorkflowOption jna-CodexAutoApply';
        this.codexAutoApply = document.createElement('input');
        this.codexAutoApply.type = 'checkbox';
        this.codexAutoApply.checked = this.codexAutoApplySetting;
        this.codexAutoApply.onchange = () => {
            this.codexAutoApplySetting = this.codexAutoApply.checked;
            this.persistSettings();
        };
        this.codexAutoApplyLine.append(this.codexAutoApply, document.createTextNode('Automatically apply after patch generation'));
        this.codexActions.append(codexButtonRow, this.workingLabel, this.codexAutoApplyLine);
        this.chatGPTActions = document.createElement('div');
        this.chatGPTActions.className = 'jna-Section';
        this.chatGPTActions.style.marginTop = '9px';
        const manualButtons = document.createElement('div');
        manualButtons.className = 'jna-ButtonRow';
        this.openChatGPTButton = button('Open ChatGPT');
        this.copyPromptButton = button('Copy prompt');
        this.openChatGPTButton.onclick = () => void this.openChatGPT();
        this.copyPromptButton.onclick = () => void this.copyPrompt();
        manualButtons.append(this.openChatGPTButton, this.copyPromptButton);
        this.responseInput = document.createElement('textarea');
        this.responseInput.className = 'jna-ResponseInput';
        this.responseInput.placeholder =
            'Paste the ChatGPT response here to validate it and display an applicable notebook patch…';
        this.responseInput.style.marginTop = '8px';
        this.responseInput.addEventListener('input', () => this.updateManualPasteState());
        this.responseInput.addEventListener('keydown', event => {
            if (this.shouldSubmitFromInput(event)) {
                event.preventDefault();
                event.stopPropagation();
                this.runPasteFieldPrimaryAction();
            }
        });
        this.responseInput.addEventListener('paste', () => {
            window.setTimeout(() => {
                this.updateManualPasteState();
                if (this.autoParseAfterPaste.checked && this.responseInput.value.trim()) {
                    void this.parseManualResponse();
                }
            }, 0);
        });
        const autoParseLine = document.createElement('label');
        autoParseLine.className = 'jna-OptionLine jna-WorkflowOption';
        this.autoParseAfterPaste = document.createElement('input');
        this.autoParseAfterPaste.type = 'checkbox';
        autoParseLine.append(this.autoParseAfterPaste, document.createTextNode('Automatically parse after paste'));
        this.parseButton = button('Parse pasted response');
        this.parseButton.onclick = () => void this.parseManualResponse();
        this.chatGPTActions.append(manualButtons, this.responseInput, autoParseLine, this.parseButton);
        taskSection.append(this.codexActions, this.chatGPTActions);
        this.resultSection = document.createElement('div');
        this.resultSection.className = 'jna-Section';
        const resultHeader = document.createElement('div');
        resultHeader.className = 'jna-ResultHeader';
        resultHeader.appendChild(sectionTitle('Conversation / result'));
        this.resultSection.appendChild(resultHeader);
        this.detailsToggleButton = button('−', 'jna-IconButton', 'Minimize diff');
        this.detailsToggleButton.setAttribute('aria-label', 'Minimize diff');
        this.detailsToggleButton.onclick = () => this.setDetailsCollapsed(!this.detailsCollapsed);
        this.resultNode = document.createElement('div');
        this.resultNode.className = 'jna-Result';
        this.resultSection.appendChild(this.resultNode);
        this.statusMessage = document.createElement('div');
        this.statusMessage.className = 'jna-StatusMessage';
        this.resultSection.appendChild(this.statusMessage);
        this.manualAutoApplyLine = document.createElement('label');
        this.manualAutoApplyLine.className = 'jna-OptionLine jna-WorkflowOption';
        this.autoApplyAfterParse = document.createElement('input');
        this.autoApplyAfterParse.type = 'checkbox';
        this.autoApplyAfterParse.checked = this.autoApplyAfterParseSetting;
        this.autoApplyAfterParse.onchange = () => {
            this.autoApplyAfterParseSetting = this.autoApplyAfterParse.checked;
            this.persistSettings();
        };
        this.manualAutoApplyLine.append(this.autoApplyAfterParse, document.createTextNode('Automatically apply after parse'));
        this.resultSection.append(this.manualAutoApplyLine);
        this.patchActionRow = document.createElement('div');
        this.patchActionRow.className = 'jna-PatchActionRow';
        const leftActions = document.createElement('div');
        leftActions.className = 'jna-ButtonRow';
        this.undoButton = button('Undo AI changes');
        this.rejectButton = button('Reject');
        this.undoButton.onclick = () => this.undoChanges();
        this.rejectButton.onclick = () => this.rejectPatch();
        leftActions.append(this.undoButton);
        const historyActions = document.createElement('div');
        historyActions.className = 'jna-HistoryAction';
        this.historyButton = button('Session AI history');
        this.historyButton.onclick = () => this.requestHistoryOpen?.();
        historyActions.appendChild(this.historyButton);
        const runLine = document.createElement('label');
        runLine.className = 'jna-OptionLine jna-AutoRunOption';
        this.autoRunOnApply = document.createElement('input');
        this.autoRunOnApply.type = 'checkbox';
        this.autoRunOnApply.checked = this.autoRunOnApplySetting;
        this.autoRunOnApply.onchange = () => {
            this.autoRunOnApplySetting = this.autoRunOnApply.checked;
            this.persistSettings();
        };
        runLine.append(this.autoRunOnApply, document.createTextNode('Automatically run selected cell(s) on apply'));
        const applyColumn = document.createElement('div');
        applyColumn.className = 'jna-ApplyColumn';
        const rightActions = document.createElement('div');
        rightActions.className = 'jna-ButtonRow jna-Right';
        this.applyButton = button('Apply');
        this.applyButton.onclick = () => void this.applyPatch();
        rightActions.append(this.rejectButton, this.applyButton);
        applyColumn.append(runLine, rightActions);
        this.patchActionRow.append(leftActions, historyActions, applyColumn);
        this.resultSection.appendChild(this.patchActionRow);
        this.contentNode.append(this.successBanner, modeSection, taskSection, this.resultSection);
        const bottom = document.createElement('div');
        bottom.className = 'jna-BottomStatus';
        this.targetStatus = document.createElement('span');
        this.processStatus = document.createElement('span');
        this.processStatus.textContent = '● Ready';
        bottom.append(this.targetStatus, this.processStatus);
        this.node.append(this.agentBanner, header, this.contentNode, bottom);
        this.renderEmptyResult();
        this.setApplyButtonReady(false);
        this.resetManualVisualState(false);
    }
    isReadyButton(element) {
        return !element.hidden && !element.disabled && element.dataset.state === 'ready';
    }
    shouldSubmitFromInput(event) {
        if (event.key !== 'Enter' ||
            event.isComposing ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey) {
            return false;
        }
        return this.enterSubmits ? !event.shiftKey : event.shiftKey;
    }
    runTaskFieldPrimaryAction() {
        if (this.mode === 'codex') {
            if (!this.generateButton.hidden && !this.generateButton.disabled && !this.busy) {
                this.generateButton.click();
            }
            return;
        }
        const nextButton = [this.openChatGPTButton, this.copyPromptButton].find(element => this.isReadyButton(element));
        if (nextButton) {
            nextButton.click();
        }
    }
    runPasteFieldPrimaryAction() {
        if (this.mode !== 'chatgpt') {
            return;
        }
        if (this.isReadyButton(this.parseButton)) {
            this.parseButton.click();
        }
    }
    setButtonState(element, state, label) {
        element.dataset.state = state;
        if (label !== undefined) {
            element.textContent = label;
        }
    }
    flashButtonSuccess(element, successLabel, finalLabel, onComplete) {
        const previous = this.feedbackTimers.get(element);
        if (previous !== undefined) {
            window.clearTimeout(previous);
        }
        this.setButtonState(element, 'success', `✓ ${successLabel}`);
        const timer = window.setTimeout(() => {
            this.feedbackTimers.delete(element);
            this.setButtonState(element, 'neutral', finalLabel);
            onComplete?.();
        }, 2000);
        this.feedbackTimers.set(element, timer);
    }
    showPatchAppliedBanner() {
        // A repeated apply restarts the full five-second display period.
        if (this.successBannerTimer !== null) {
            window.clearTimeout(this.successBannerTimer);
        }
        this.successBanner.hidden = false;
        // Clear only the rendered conversation/diff while preserving the patch snapshot for Undo.
        this.resultNode.replaceChildren();
        this.patchDetailsNode = null;
        this.detailsCollapsed = false;
        // Jump to the top immediately so the confirmation cannot remain outside the viewport.
        this.contentNode.scrollTop = 0;
        this.successBannerTimer = window.setTimeout(() => {
            this.successBanner.hidden = true;
            this.successBannerTimer = null;
        }, 5000);
    }
    setDetailsCollapsed(collapsed) {
        this.detailsCollapsed = collapsed;
        if (this.patchDetailsNode) {
            this.patchDetailsNode.hidden = collapsed;
        }
        this.detailsToggleButton.textContent = collapsed ? '+' : '−';
        this.detailsToggleButton.title = collapsed ? 'Restore diff' : 'Minimize diff';
        this.detailsToggleButton.setAttribute('aria-label', collapsed ? 'Restore diff' : 'Minimize diff');
    }
    resetManualVisualState(focus) {
        this.taskInput.dataset.state = 'active';
        this.responseInput.dataset.state = 'neutral';
        this.setButtonState(this.openChatGPTButton, 'neutral', 'Open ChatGPT');
        this.setButtonState(this.copyPromptButton, 'neutral', 'Copy prompt');
        this.setButtonState(this.parseButton, 'neutral', 'Parse pasted response');
        this.parseButton.disabled = false;
        if (focus) {
            this.contentNode.scrollTo({ top: 0, behavior: 'smooth' });
            window.setTimeout(() => this.taskInput.focus(), 150);
        }
        this.updateManualTaskState();
    }
    updateManualTaskState() {
        if (this.mode !== 'chatgpt') {
            return;
        }
        const hasText = Boolean(this.taskInput.value.trim());
        if (this.taskInput.dataset.state !== 'locked') {
            this.taskInput.dataset.state = 'active';
        }
        this.setButtonState(this.openChatGPTButton, hasText ? 'ready' : 'neutral', 'Open ChatGPT');
        this.setButtonState(this.copyPromptButton, 'neutral', 'Copy prompt');
        this.openChatGPTButton.disabled = false;
        this.copyPromptButton.disabled = false;
    }
    updateManualPasteState() {
        if (this.mode !== 'chatgpt') {
            return;
        }
        const hasText = Boolean(this.responseInput.value.trim());
        this.responseInput.dataset.state = hasText ? 'active' : 'paste-ready';
        this.parseButton.disabled = false;
        this.setButtonState(this.parseButton, hasText ? 'ready' : 'neutral', 'Parse pasted response');
    }
    clearResultState() {
        this.currentPatch = null;
        this.patchContext = null;
        this.patchOptions = null;
        this.patchApplied = false;
        this.currentHistoryEntryId = null;
        this.operationChecks = [];
        this.renderEmptyResult();
        this.setApplyButtonReady(false);
    }
    async openCodexLoginDialog() {
        const body = new Widget();
        body.addClass('jna-LoginDialog');
        const explanation = document.createElement('p');
        explanation.textContent =
            'Open a JupyterLab terminal, paste the commands below, and follow the device-authentication instructions.';
        const commands = document.createElement('pre');
        commands.className = 'jna-LoginCommands';
        commands.textContent = CODEX_LOGIN_INSTRUCTIONS;
        const copyButton = button('Copy commands', 'jna-Button jp-mod-accept');
        copyButton.onclick = async () => {
            try {
                await navigator.clipboard.writeText(CODEX_LOGIN_INSTRUCTIONS);
                copyButton.textContent = 'Copied';
                copyButton.disabled = true;
                window.setTimeout(() => {
                    if (!copyButton.isConnected) {
                        return;
                    }
                    copyButton.textContent = 'Copy commands';
                    copyButton.disabled = false;
                }, 1800);
            }
            catch (error) {
                this.setStatus(`Could not copy the login commands: ${error instanceof Error ? error.message : String(error)}`, '● Error', 'error');
            }
        };
        const actions = document.createElement('div');
        actions.className = 'jna-ButtonRow jna-Right';
        actions.appendChild(copyButton);
        body.node.append(explanation, commands, actions);
        await showDialog({
            title: 'Codex login',
            body,
            buttons: [Dialog.okButton({ label: 'Close' })]
        });
    }
    initializeCodexTaskField() {
        this.taskInput.dataset.state = 'neutral';
    }
    setMode(mode) {
        if (this.mode === mode) {
            return;
        }
        if (mode === 'chatgpt' && this.workingMode === 'agent') {
            this.workingMode = 'local';
        }
        this.mode = mode;
        this.generateLockedUntilInput = false;
        this.updateGenerateButtonState();
        this.persistSettings();
        if (mode === 'chatgpt') {
            if (this.busy) {
                void this.codexRunner.cancel();
                this.setBusy(false);
            }
            this.responseInput.value = '';
            this.clearResultState();
            this.setStatus('', '● Ready');
            this.setDetailsCollapsed(false);
            this.resetManualVisualState(false);
        }
        this.updateModeUI();
    }
    updateModeUI() {
        this.modeCodexButton.dataset.active = String(this.mode === 'codex');
        this.modeChatGPTButton.dataset.active = String(this.mode === 'chatgpt');
        this.codexOptions.hidden = this.mode !== 'codex';
        this.codexActions.hidden = this.mode !== 'codex';
        this.chatGPTActions.hidden = this.mode !== 'chatgpt';
        this.manualAutoApplyLine.hidden = this.mode !== 'chatgpt';
        this.codexAutoApplyLine.hidden = this.mode !== 'codex';
        if (this.mode === 'chatgpt') {
            this.resetManualVisualState(false);
        }
        else {
            this.initializeCodexTaskField();
            this.taskInput.dataset.state = 'neutral';
        }
        this.renderEmptyResult();
        this.setApplyButtonReady(false);
        this.updateWorkingModeUI();
    }
    updateWorkingModeUI() {
        const agentActive = this.workingMode === 'agent';
        this.agentBanner.hidden = !agentActive;
        this.agentBanner.textContent =
            agentActive && this.agentPermissions.disableCodexSandbox
                ? 'Agent mode active — Codex OS sandbox disabled'
                : 'Agent mode active';
        this.agentModeToggle.dataset.active = String(agentActive);
        this.agentModeToggle.setAttribute('aria-checked', String(agentActive));
        this.agentModeButton.dataset.active = String(agentActive);
        this.generateButton.textContent = agentActive ? 'Run agent' : 'Generate patch';
        this.codexAutoApplyLine.hidden = this.mode !== 'codex' || agentActive;
        this.patchActionRow.hidden = agentActive;
        this.workingLabel.textContent = agentActive
            ? 'Working... do not modify the notebook or project files now.'
            : 'Working... do not modify the notebook now.';
    }
    async confirmAgentActivation() {
        const body = new Widget();
        const warning = document.createElement('div');
        warning.className = 'jna-AgentWarning';
        warning.textContent = AGENT_MODE_WARNING;
        const explanation = document.createElement('p');
        explanation.textContent = this.agentPermissions.disableCodexSandbox
            ? 'In agent mode, Codex runs commands through the Jupyter terminal service. Cluster compatibility mode is enabled, so Codex runs without its operating-system sandbox and has the same access as your JupyterHub user.'
            : 'In agent mode, Codex runs commands through the Jupyter terminal service and may modify files immediately, depending on the permissions you grant.';
        body.node.append(warning, explanation);
        const result = await showDialog({
            title: 'Enable agent mode?',
            body,
            buttons: [
                Dialog.cancelButton({ label: 'Cancel' }),
                Dialog.okButton({ label: 'Enable agent mode' })
            ]
        });
        return result.button.accept;
    }
    async setWorkingMode(mode, confirmActivation = true) {
        if (mode === this.workingMode) {
            return true;
        }
        if (mode === 'agent' && confirmActivation) {
            const accepted = await this.confirmAgentActivation();
            if (!accepted) {
                return false;
            }
        }
        if (this.busy) {
            await this.codexRunner.cancel();
            this.setBusy(false);
        }
        if (mode === 'agent' && this.mode !== 'codex') {
            this.mode = 'codex';
        }
        this.workingMode = mode;
        this.generateLockedUntilInput = false;
        this.clearResultState();
        this.persistSettings();
        this.updateModeUI();
        this.updateGenerateButtonState();
        this.setStatus(mode === 'agent'
            ? 'Agent mode active. Review the permissions before every project-wide task.'
            : 'Local notebook mode active.', '● Ready', mode === 'agent' ? 'error' : 'success');
        return true;
    }
    async toggleAgentMode() {
        await this.setWorkingMode(this.workingMode === 'agent' ? 'local' : 'agent');
    }
    createAgentAccessSelect(value, onChange) {
        const select = document.createElement('select');
        select.className = 'jna-AgentAccessSelect';
        for (const [optionValue, label] of [
            ['none', 'No access'],
            ['read', 'Read'],
            ['write', 'Write']
        ]) {
            const option = document.createElement('option');
            option.value = optionValue;
            option.textContent = label;
            select.appendChild(option);
        }
        select.value = value;
        select.onchange = () => onChange(select.value);
        return select;
    }
    async openAgentModeDialog() {
        const draft = cloneAgentPermissions(this.agentPermissions);
        let draftMode = this.workingMode;
        const body = new Widget();
        body.addClass('jna-AgentDialog');
        const warning = document.createElement('div');
        warning.className = 'jna-AgentWarning';
        warning.textContent = AGENT_MODE_WARNING;
        const rootGroup = document.createElement('div');
        rootGroup.className = 'jna-AgentGroup';
        rootGroup.appendChild(sectionTitle('Project root'));
        const rootInput = document.createElement('input');
        rootInput.type = 'text';
        rootInput.className = 'jna-AgentPathInput';
        rootInput.value = draft.projectRoot;
        rootInput.placeholder = './';
        rootInput.spellcheck = false;
        rootInput.oninput = () => {
            draft.projectRoot = rootInput.value;
        };
        const rootHelp = document.createElement('div');
        rootHelp.className = 'jna-AgentHelp';
        rootHelp.textContent =
            'Relative paths are resolved from the directory of the current notebook.';
        rootGroup.append(rootInput, rootHelp);
        const workingGroup = document.createElement('div');
        workingGroup.className = 'jna-AgentGroup';
        workingGroup.appendChild(sectionTitle('Working mode'));
        const workingRow = document.createElement('div');
        workingRow.className = 'jna-AgentWorkingMode';
        const localLabel = document.createElement('span');
        localLabel.textContent = 'Local (rights defined in Notebook permissions)';
        const modeToggle = button('', 'jna-ToggleButton', 'Change working mode');
        modeToggle.setAttribute('role', 'switch');
        const agentLabel = document.createElement('span');
        agentLabel.textContent = 'Agent mode';
        const updateModeToggle = () => {
            modeToggle.dataset.active = String(draftMode === 'agent');
            modeToggle.setAttribute('aria-checked', String(draftMode === 'agent'));
        };
        modeToggle.onclick = () => {
            draftMode = draftMode === 'agent' ? 'local' : 'agent';
            updateModeToggle();
        };
        localLabel.onclick = () => {
            draftMode = 'local';
            updateModeToggle();
        };
        agentLabel.onclick = () => {
            draftMode = 'agent';
            updateModeToggle();
        };
        workingRow.append(localLabel, modeToggle, agentLabel);
        workingGroup.appendChild(workingRow);
        updateModeToggle();
        const permissionsGroup = document.createElement('div');
        permissionsGroup.className = 'jna-AgentGroup';
        permissionsGroup.appendChild(sectionTitle('Agent mode permissions'));
        const addAccessRow = (labelText, key, extra) => {
            const row = document.createElement('div');
            row.className = 'jna-AgentPermissionRow';
            const label = document.createElement('span');
            label.textContent = labelText;
            const controls = document.createElement('div');
            controls.className = 'jna-AgentPermissionControls';
            if (extra) {
                controls.appendChild(extra);
            }
            controls.appendChild(this.createAgentAccessSelect(draft[key], value => {
                draft[key] = value;
            }));
            row.append(label, controls);
            permissionsGroup.appendChild(row);
        };
        addAccessRow('Notebook directory', 'notebookDirectory');
        addAccessRow('Notebook subdirectories', 'notebookSubdirectories');
        addAccessRow('Project files referenced in the current notebook', 'referencedInNotebook');
        addAccessRow('Project files referenced by those references', 'referencedInReferences');
        const parentLevels = document.createElement('input');
        parentLevels.type = 'number';
        parentLevels.className = 'jna-AgentLevelInput';
        parentLevels.min = '0';
        parentLevels.max = '20';
        parentLevels.step = '1';
        parentLevels.value = String(draft.parentLevels);
        parentLevels.title = 'Number of parent-directory levels';
        parentLevels.oninput = () => {
            const value = Number(parentLevels.value);
            draft.parentLevels = Number.isFinite(value)
                ? Math.max(0, Math.min(20, Math.trunc(value)))
                : 1;
        };
        addAccessRow('All files in parent directories up to the selected number of levels', 'parentAccess', parentLevels);
        const checkboxGroup = document.createElement('div');
        checkboxGroup.className = 'jna-AgentCheckboxGrid';
        const addPermissionCheckbox = (labelText, key) => {
            const label = document.createElement('label');
            label.className = 'jna-OptionLine';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = draft[key];
            input.onchange = () => {
                draft[key] = input.checked;
            };
            label.append(input, document.createTextNode(labelText));
            checkboxGroup.appendChild(label);
        };
        addPermissionCheckbox('Add files', 'addFiles');
        addPermissionCheckbox('Delete files', 'deleteFiles');
        addPermissionCheckbox('Run tests', 'runTests');
        addPermissionCheckbox('Run arbitrary terminal commands', 'runArbitraryCommands');
        permissionsGroup.appendChild(checkboxGroup);
        const compatibilityLabel = document.createElement('label');
        compatibilityLabel.className = 'jna-OptionLine jna-AgentCompatibilityToggle';
        const compatibilityCheckbox = document.createElement('input');
        compatibilityCheckbox.type = 'checkbox';
        compatibilityCheckbox.checked = draft.disableCodexSandbox;
        const compatibilityText = document.createElement('span');
        compatibilityText.textContent =
            'Cluster compatibility mode: disable the Codex OS sandbox';
        compatibilityLabel.append(compatibilityCheckbox, compatibilityText);
        const compatibilityWarning = document.createElement('div');
        compatibilityWarning.className = 'jna-AgentCompatibilityWarning';
        const updateCompatibilityWarning = () => {
            draft.disableCodexSandbox = compatibilityCheckbox.checked;
            compatibilityWarning.hidden = !draft.disableCodexSandbox;
            compatibilityWarning.textContent = draft.disableCodexSandbox
                ? 'Danger: Codex will run with danger-full-access because this cluster cannot start the Linux bubblewrap sandbox. The directory permissions and white-/blacklist remain instructions to the agent, but are no longer enforced by an operating-system sandbox.'
                : '';
        };
        compatibilityCheckbox.onchange = updateCompatibilityWarning;
        updateCompatibilityWarning();
        permissionsGroup.append(compatibilityLabel, compatibilityWarning);
        const patternGroup = document.createElement('div');
        patternGroup.className = 'jna-AgentGroup';
        const policyBoundaryLabel = document.createElement('label');
        policyBoundaryLabel.className = 'jna-OptionLine jna-AgentBoundaryToggle';
        const policyBoundaryCheckbox = document.createElement('input');
        policyBoundaryCheckbox.type = 'checkbox';
        policyBoundaryCheckbox.checked = draft.policyBoundariesEnabled;
        policyBoundaryLabel.append(policyBoundaryCheckbox, document.createTextNode('Enable agent policy boundaries:'));
        patternGroup.append(policyBoundaryLabel, sectionTitle('Whitelist / blacklist'));
        const patternModeRow = document.createElement('div');
        patternModeRow.className = 'jna-AgentWorkingMode';
        const whitelistLabel = document.createElement('span');
        whitelistLabel.textContent = 'Whitelist';
        const patternToggle = button('', 'jna-ToggleButton', 'Switch white-/blacklist');
        patternToggle.setAttribute('role', 'switch');
        const blacklistLabel = document.createElement('span');
        blacklistLabel.textContent = 'Blacklist';
        const updatePatternToggle = () => {
            const blacklist = draft.patternMode === 'blacklist';
            patternToggle.dataset.active = String(blacklist);
            patternToggle.setAttribute('aria-checked', String(blacklist));
        };
        const setPatternMode = (mode) => {
            if (!draft.policyBoundariesEnabled) {
                return;
            }
            draft.patternMode = mode;
            updatePatternToggle();
        };
        patternToggle.onclick = () => setPatternMode(draft.patternMode === 'whitelist' ? 'blacklist' : 'whitelist');
        whitelistLabel.onclick = () => setPatternMode('whitelist');
        blacklistLabel.onclick = () => setPatternMode('blacklist');
        patternModeRow.append(whitelistLabel, patternToggle, blacklistLabel);
        const patternInput = document.createElement('textarea');
        patternInput.className = 'jna-AgentPatternInput';
        patternInput.value = draft.patterns;
        patternInput.placeholder = '*.py\n*.ipynb\n./imgs/*';
        patternInput.spellcheck = false;
        patternInput.oninput = () => {
            draft.patterns = patternInput.value;
        };
        const patternHelp = document.createElement('div');
        patternHelp.className = 'jna-AgentHelp';
        patternHelp.textContent =
            'Enter one filename or directory glob per line, for example *.py, *.ipynb, or ./imgs/*.';
        patternGroup.append(patternModeRow, patternInput, patternHelp);
        const updatePolicyBoundaryControls = () => {
            const enabled = draft.policyBoundariesEnabled;
            patternToggle.disabled = !enabled;
            patternInput.disabled = !enabled;
            patternModeRow.dataset.disabled = String(!enabled);
            patternHelp.textContent = enabled
                ? 'Enter one filename or directory glob per line, for example *.py, *.ipynb, or ./imgs/*.'
                : draft.disableCodexSandbox
                    ? 'Policy-boundary patterns are disabled. Only the path-category instructions remain; no Codex operating-system sandbox is active.'
                    : 'Policy-boundary patterns are disabled. Path permissions and the Codex sandbox still apply.';
        };
        policyBoundaryCheckbox.onchange = () => {
            draft.policyBoundariesEnabled = policyBoundaryCheckbox.checked;
            updatePolicyBoundaryControls();
        };
        updatePatternToggle();
        updatePolicyBoundaryControls();
        const enforcementNote = document.createElement('div');
        enforcementNote.className = 'jna-AgentEnforcementNote';
        const updateEnforcementNote = () => {
            enforcementNote.textContent = draft.disableCodexSandbox
                ? 'Cluster compatibility mode is active. Codex is started with danger-full-access, so project-root, path-category, and white-/blacklist boundaries are agent instructions only and are not enforced by the Codex operating-system sandbox.'
                : 'Codex is started with a read-only or workspace-write sandbox. Project-root and additional writable-directory boundaries are enforced by the Codex sandbox. The detailed overlapping path categories use the most permissive matching grant; optional whitelist/blacklist patterns are supplied as an additional mandatory agent policy.';
        };
        compatibilityCheckbox.addEventListener('change', () => {
            updateEnforcementNote();
            updatePolicyBoundaryControls();
        });
        updateEnforcementNote();
        body.node.append(warning, workingGroup, rootGroup, permissionsGroup, patternGroup, enforcementNote);
        const result = await showDialog({
            title: 'Agent mode',
            body,
            buttons: [
                Dialog.cancelButton({ label: 'Cancel' }),
                Dialog.okButton({ label: 'Apply' })
            ]
        });
        if (!result.button.accept) {
            return;
        }
        if (draft.disableCodexSandbox && !this.agentPermissions.disableCodexSandbox) {
            const compatibilityBody = new Widget();
            const compatibilityDanger = document.createElement('div');
            compatibilityDanger.className = 'jna-AgentWarning';
            compatibilityDanger.textContent =
                'You are about to disable the Codex operating-system sandbox. Codex will have the same filesystem and command access as your JupyterHub user. The configured agent permissions will no longer be hard security boundaries.';
            const compatibilityExplanation = document.createElement('p');
            compatibilityExplanation.textContent =
                'Use this only when Terminal diagnostics report a bubblewrap error such as “bwrap: pivot_root: Invalid argument”, and only in a trusted project and cluster environment.';
            compatibilityBody.node.append(compatibilityDanger, compatibilityExplanation);
            const compatibilityResult = await showDialog({
                title: 'Enable cluster compatibility mode?',
                body: compatibilityBody,
                buttons: [
                    Dialog.cancelButton({ label: 'Keep sandbox enabled' }),
                    Dialog.warnButton({ label: 'Disable sandbox' })
                ]
            });
            if (!compatibilityResult.button.accept) {
                return;
            }
        }
        draft.projectRoot = draft.projectRoot.trim() || './';
        draft.parentLevels = Math.max(0, Math.min(20, Math.trunc(Number(draft.parentLevels) || 0)));
        this.agentPermissions = draft;
        if (draftMode === 'agent' && this.workingMode !== 'agent') {
            const enabled = await this.setWorkingMode('agent', true);
            if (!enabled) {
                this.persistSettings();
                return;
            }
        }
        else {
            await this.setWorkingMode(draftMode, false);
        }
        this.persistSettings();
        this.updateWorkingModeUI();
        this.setStatus('Agent settings saved.', '● Ready', 'success');
    }
    onAfterShow(message) {
        super.onAfterShow(message);
        if (this.statusDirty) {
            this.scheduleNotebookStatusRefresh();
        }
    }
    onNotebookTargetChanged() {
        this.statusDirty = true;
        this.scheduleNotebookStatusRefresh();
    }
    scheduleNotebookStatusRefresh() {
        if (!this.isVisible || this.statusFrame) {
            return;
        }
        this.statusFrame = window.requestAnimationFrame(() => {
            this.statusFrame = 0;
            if (!this.isVisible) {
                return;
            }
            this.refreshNotebookStatus();
        });
    }
    refreshNotebookStatus() {
        this.statusDirty = false;
        const panel = this.panel;
        if (!panel) {
            this.targetStatus.textContent = 'No notebook active';
            this.contextButton.textContent = 'Notebook permissions · no notebook';
            return;
        }
        const notebook = panel.content;
        const indexes = notebook.widgets
            .map((cell, index) => (notebook.isSelectedOrActive(cell) ? index : -1))
            .filter(index => index >= 0);
        this.targetStatus.textContent = `Cell ${notebook.activeCellIndex} active · ${indexes.length} selected`;
        const contextCellCount = countNotebookContextCells(panel, this.contextOptions);
        this.contextButton.textContent = `Notebook permissions · ${contextCellCount} cells ▾`;
    }
    setStatus(message, process = '● Ready', level = 'normal') {
        this.statusMessage.textContent = message;
        this.statusMessage.dataset.level = level;
        this.processStatus.textContent = process;
    }
    updateGenerateButtonState() {
        this.generateButton.disabled = this.busy || this.generateLockedUntilInput;
        this.generateButton.title = this.generateLockedUntilInput
            ? 'Edit the task text before generating another patch.'
            : '';
    }
    setBusy(busy) {
        this.busy = busy;
        this.updateGenerateButtonState();
        this.cancelButton.hidden = !busy;
        // Keep the warning synchronized with the complete Codex request lifecycle,
        // including cancellation and errors handled by the caller's finally block.
        this.workingLabel.hidden = !busy;
    }
    requirePanel() {
        const panel = this.panel;
        if (!panel) {
            throw new Error('Open and activate a notebook first.');
        }
        return panel;
    }
    async consumeAssistantDirective() {
        if (this.busy) {
            this.setStatus('The assistant is already processing a request.', '● Busy', 'error');
            return;
        }
        try {
            const panel = this.requirePanel();
            const activeCell = panel.content.activeCell;
            if (!activeCell) {
                throw new Error('Select a notebook cell containing an @assistant comment.');
            }
            if (activeCell.model.type !== 'code') {
                throw new Error('The @assistant shortcut currently requires an active code cell.');
            }
            const source = activeCell.model.sharedModel.getSource();
            const directive = extractAssistantDirective(source);
            if (!directive) {
                throw new Error('No non-empty @assistant message was found in a comment of the active cell.');
            }
            this.requestActivation?.();
            activeCell.model.sharedModel.setSource(directive.cleanedSource);
            this.taskInput.value = directive.message;
            this.generateLockedUntilInput = false;
            this.updateGenerateButtonState();
            this.responseInput.value = '';
            this.clearResultState();
            this.setDetailsCollapsed(false);
            this.contentNode.scrollTo({ top: 0, behavior: 'smooth' });
            this.updateManualTaskState();
            this.setStatus('Moved the @assistant comment into the task field.', this.mode === 'codex' ? '● Generating patch' : '● Copying prompt', 'success');
            if (this.mode === 'codex') {
                await this.generateCodexPatch();
            }
            else {
                await this.copyPrompt();
            }
        }
        catch (error) {
            this.requestActivation?.();
            this.setStatus(error instanceof Error ? error.message : String(error), '● Error', 'error');
        }
    }
    buildPrompt(manualMode) {
        const task = this.taskInput.value.trim();
        if (!task) {
            throw new Error('Enter a task before generating a prompt.');
        }
        const options = { ...this.contextOptions };
        const context = collectNotebookContext(this.requirePanel(), options);
        if (!context.cells.length) {
            throw new Error('The selected context contains no cells.');
        }
        return {
            context,
            options,
            prompt: buildAssistantPrompt(task, context, options, manualMode, this.includeUserInstruction ? this.userInstruction : '')
        };
    }
    buildAgentPrompt() {
        const task = this.taskInput.value.trim();
        if (!task) {
            throw new Error('Enter a task before running the agent.');
        }
        const panel = this.requirePanel();
        const options = { ...this.contextOptions };
        const context = collectNotebookContext(panel, options);
        const permissions = this.agentPermissions;
        const notebookDirectory = notebookDirectoryPath(panel);
        const projectRoot = resolveProjectRoot(panel, permissions.projectRoot);
        const parentRoot = parentDirectory(projectRoot, permissions.parentLevels);
        const permissionLines = [
            `Notebook directory (${notebookDirectory}): ${accessLabel(permissions.notebookDirectory)}`,
            `Notebook subdirectories: ${accessLabel(permissions.notebookSubdirectories)}`,
            `Project files referenced in the current notebook: ${accessLabel(permissions.referencedInNotebook)}`,
            `Project files referenced recursively by those references: ${accessLabel(permissions.referencedInReferences)}`,
            `All files in parent directories up to ${permissions.parentLevels} level(s) above project root (${parentRoot}): ${accessLabel(permissions.parentAccess)}`,
            `Add files: ${permissions.addFiles ? 'allowed' : 'forbidden'}`,
            `Delete files: ${permissions.deleteFiles ? 'allowed' : 'forbidden'}`,
            `Run tests: ${permissions.runTests ? 'allowed' : 'forbidden'}`,
            `Run arbitrary terminal commands: ${permissions.runArbitraryCommands ? 'allowed' : 'forbidden'}`,
            `Codex OS sandbox: ${permissions.disableCodexSandbox
                ? 'disabled (cluster compatibility mode; danger-full-access)'
                : 'enabled'}`,
            `Agent policy boundaries: ${permissions.policyBoundariesEnabled ? 'enabled' : 'disabled'}`,
            ...(permissions.policyBoundariesEnabled
                ? [
                    `${permissions.patternMode === 'whitelist'
                        ? 'Whitelist'
                        : 'Blacklist'} patterns:\n${permissions.patterns.trim() || '[none]'}`
                ]
                : [])
        ];
        const instructions = this.includeUserInstruction
            ? this.userInstruction.trim()
            : '';
        const prompt = [
            'You are operating as a project agent from a JupyterLab extension.',
            '',
            'TASK',
            task,
            '',
            'MANDATORY ACCESS POLICY',
            `Project root: ${projectRoot}`,
            ...permissionLines,
            '',
            'The path categories overlap. For each path, determine every category that matches and use the most permissive matching grant, ordered as no access < read < write. A no-access value in one overlapping category does not revoke read or write access granted by another matching category. For example, a local module in the notebook directory is readable when Notebook directory is set to Read, even when Project files referenced in the current notebook is set to No access. Paths with no matching read or write grant are forbidden: do not list, read, search, stat, open, or modify them. Read-only paths may be inspected but never changed. Writable paths may be changed only when necessary for the task. Never broaden the granted scope, follow symlinks to evade it, or modify credentials, environment configuration, hidden authentication files, Git internals, or unrelated data.',
            permissions.runArbitraryCommands
                ? 'Arbitrary terminal commands are allowed, but use the least destructive command that completes the task.'
                : 'Do not run arbitrary terminal commands. You may use only minimal read-only discovery commands needed to inspect permitted source files, plus explicitly permitted tests.',
            permissions.runTests
                ? 'Run relevant tests after changes when practical and report their exact outcome.'
                : 'Do not run tests, test runners, build systems, package installers, or dependency lifecycle scripts.',
            permissions.addFiles
                ? 'New files may be created only inside paths with write access and only when required.'
                : 'Do not create any new file.',
            permissions.deleteFiles
                ? 'Files may be deleted only inside paths with write access and only when required.'
                : 'Do not delete or rename any existing file.',
            permissions.policyBoundariesEnabled
                ? `Apply the ${permissions.patternMode} patterns to both reads and writes after resolving the overlapping path grants. For a whitelist, all unmatched paths are forbidden. For a blacklist, matching paths are forbidden.`
                : permissions.disableCodexSandbox
                    ? 'Filename and directory pattern boundaries are disabled. Apply only the path-category permissions. No operating-system sandbox is active.'
                    : 'Filename and directory pattern boundaries are disabled. Apply only the path-category permissions and the Codex sandbox boundary.',
            permissions.disableCodexSandbox
                ? 'IMPORTANT: The Codex operating-system sandbox is disabled for cluster compatibility. Treat every configured path and command restriction as mandatory. Do not inspect or touch any path outside the granted policy, even though the host operating system would allow it.'
                : 'The Codex operating-system sandbox is active and provides the hard filesystem boundary for command execution.',
            'Do not edit the currently open notebook file directly unless the task explicitly requires that and the path is writable. Prefer editing imported source files when that is the actual location of the defect.',
            'Before changing anything, inspect the relevant dependency chain. Make the smallest coherent change. In the final response, list every file changed, added, or deleted and every command or test run. If the permissions prevent the task, stop and explain which permission is missing without attempting a workaround.',
            instructions ? `\nUSER INSTRUCTIONS\n${instructions}` : '',
            '',
            'CURRENT NOTEBOOK CONTEXT',
            formatNotebookContext(context)
        ]
            .filter(Boolean)
            .join('\n');
        const writableAccess = [
            permissions.notebookDirectory,
            permissions.notebookSubdirectories,
            permissions.referencedInNotebook,
            permissions.referencedInReferences,
            permissions.parentAccess
        ].includes('write');
        const sandbox = permissions.disableCodexSandbox
            ? 'danger-full-access'
            : writableAccess || permissions.addFiles || permissions.deleteFiles
                ? 'workspace-write'
                : 'read-only';
        const additionalWriteDirectories = new Set();
        if (permissions.notebookDirectory === 'write' ||
            permissions.notebookSubdirectories === 'write') {
            if (notebookDirectory !== projectRoot) {
                additionalWriteDirectories.add(pathRelativeToProjectRoot(projectRoot, notebookDirectory));
            }
        }
        if (permissions.parentAccess === 'write' && permissions.parentLevels > 0) {
            if (parentRoot !== projectRoot) {
                additionalWriteDirectories.add(pathRelativeToProjectRoot(projectRoot, parentRoot));
            }
        }
        return {
            context,
            prompt,
            projectRoot,
            additionalWriteDirectories: Array.from(additionalWriteDirectories),
            sandbox
        };
    }
    renderAgentResult(summary, threadId, diagnostics) {
        this.resultNode.replaceChildren();
        const header = document.createElement('div');
        header.className = 'jna-AgentResultTitle';
        header.textContent = threadId
            ? `Agent completed · Codex thread ${threadId}`
            : 'Agent completed';
        const pre = document.createElement('pre');
        pre.className = 'jna-AgentResult';
        pre.textContent = summary;
        this.resultNode.append(header, pre);
        if (diagnostics.trim()) {
            const details = document.createElement('details');
            details.className = 'jna-AgentDiagnostics';
            const detailsSummary = document.createElement('summary');
            detailsSummary.textContent = 'Terminal diagnostics';
            const diagnosticsPre = document.createElement('pre');
            diagnosticsPre.textContent = diagnostics;
            details.append(detailsSummary, diagnosticsPre);
            this.resultNode.appendChild(details);
        }
        this.setApplyButtonReady(false);
    }
    async runAgentTask() {
        if (this.mode !== 'codex' || this.workingMode !== 'agent' || this.busy) {
            return;
        }
        try {
            const built = this.buildAgentPrompt();
            this.setBusy(true);
            this.clearResultState();
            this.setStatus('Preparing project-agent context and permissions…', '● Collecting context');
            const result = await this.codexRunner.runAgent(built.prompt, {
                reasoningEffort: this.codexReasoningEffort,
                speed: this.codexSpeed,
                projectRoot: built.projectRoot,
                sandbox: built.sandbox,
                additionalWriteDirectories: built.additionalWriteDirectories
            }, message => {
                if (this.mode === 'codex' && this.workingMode === 'agent') {
                    this.setStatus(message, '● Agent working');
                }
            });
            if (this.mode !== 'codex' || this.workingMode !== 'agent') {
                return;
            }
            this.renderAgentResult(result.summary, result.threadId, result.diagnostics);
            this.generateLockedUntilInput = true;
            this.updateGenerateButtonState();
            this.setStatus('Agent run completed. Review the reported file and command changes carefully.', '● Agent completed', 'success');
        }
        catch (error) {
            if (this.mode === 'codex' && this.workingMode === 'agent') {
                this.setStatus(error instanceof Error ? error.message : String(error), '● Error', 'error');
            }
        }
        finally {
            this.setBusy(false);
        }
    }
    prepareForManualResponse() {
        this.taskInput.dataset.state = 'locked';
        this.setButtonState(this.openChatGPTButton, 'neutral', 'Open ChatGPT');
        this.setButtonState(this.copyPromptButton, 'neutral', 'Copy prompt');
        this.openChatGPTButton.disabled = false;
        this.copyPromptButton.disabled = false;
        window.setTimeout(() => {
            if (this.mode === 'chatgpt') {
                this.responseInput.dataset.state = 'paste-ready';
            }
        }, 2000);
    }
    copyTextSynchronously(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-10000px';
        textarea.style.top = '0';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        let copied = false;
        try {
            copied = document.execCommand('copy');
        }
        catch {
            copied = false;
        }
        textarea.remove();
        return copied;
    }
    async writeClipboard(text) {
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return;
            }
            catch {
                // Fall back to the user-gesture-compatible legacy copy command.
            }
        }
        if (!this.copyTextSynchronously(text)) {
            throw new Error('The browser did not permit clipboard access. Allow clipboard access for this JupyterHub and try again.');
        }
    }
    async copyPrompt() {
        try {
            const { context, options, prompt } = this.buildPrompt(true);
            this.pendingManualContext = context;
            this.pendingManualOptions = options;
            await this.writeClipboard(prompt);
            this.prepareForManualResponse();
            this.flashButtonSuccess(this.copyPromptButton, 'Copied', 'Copy prompt', () => {
                this.responseInput.dataset.state = 'paste-ready';
            });
            this.setStatus('Prompt copied. Paste it into ChatGPT, then paste the response below.', '● Prompt copied', 'success');
        }
        catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), '● Error', 'error');
        }
    }
    async openChatGPT() {
        let prompt = '';
        try {
            const built = this.buildPrompt(true);
            prompt = built.prompt;
            this.pendingManualContext = built.context;
            this.pendingManualOptions = built.options;
        }
        catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), '● Error', 'error');
            return;
        }
        // Copy synchronously while the click still carries browser user activation.
        // Opening the tab before awaiting the Clipboard API prevents popup blockers
        // from treating the navigation as an asynchronous popup.
        const copiedSynchronously = this.copyTextSynchronously(prompt);
        const chatWindow = window.open('https://chatgpt.com/', 'jupyter-notebook-assistant-chatgpt');
        if (!chatWindow) {
            let copied = copiedSynchronously;
            if (!copied) {
                try {
                    await this.writeClipboard(prompt);
                    copied = true;
                }
                catch {
                    copied = false;
                }
            }
            this.setStatus(copied
                ? 'The prompt was copied, but the browser blocked the ChatGPT tab. Allow pop-ups for this JupyterHub and try again.'
                : 'The browser blocked both the ChatGPT tab and clipboard access. Allow pop-ups and clipboard access for this JupyterHub.', '● Error', 'error');
            return;
        }
        try {
            chatWindow.focus();
        }
        catch {
            // Browser focus policy is outside the extension's control.
        }
        let copied = copiedSynchronously;
        if (!copied) {
            try {
                await this.writeClipboard(prompt);
                copied = true;
            }
            catch {
                copied = false;
            }
        }
        this.prepareForManualResponse();
        if (copied) {
            this.flashButtonSuccess(this.copyPromptButton, 'Copied', 'Copy prompt');
        }
        this.flashButtonSuccess(this.openChatGPTButton, 'Opened', 'Open ChatGPT', () => {
            this.responseInput.dataset.state = 'paste-ready';
        });
        window.setTimeout(() => {
            try {
                chatWindow.focus();
            }
            catch {
                // Some browsers intentionally keep newly opened tabs in the background.
            }
        }, 0);
        this.setStatus(copied
            ? 'Prompt copied and ChatGPT opened in an external tab. Paste and submit it there.'
            : 'ChatGPT opened, but clipboard access was denied. Press Copy prompt after allowing clipboard access.', copied ? '● ChatGPT opened' : '● Clipboard blocked', copied ? 'success' : 'error');
    }
    async generateCodexPatch() {
        if (this.mode !== 'codex' || this.busy) {
            return;
        }
        if (this.workingMode === 'agent') {
            await this.runAgentTask();
            return;
        }
        try {
            const panel = this.requirePanel();
            const { context, options, prompt } = this.buildPrompt(false);
            const kernelName = panel.sessionContext.session?.kernel?.name || 'python3';
            this.setBusy(true);
            this.patchContext = context;
            this.patchOptions = options;
            this.setStatus('Preparing notebook context…', '● Collecting context');
            const result = await this.codexRunner.run(prompt, kernelName, {
                reasoningEffort: this.codexReasoningEffort,
                speed: this.codexSpeed
            }, message => {
                if (this.mode === 'codex') {
                    this.setStatus(message, '● Codex working');
                }
            });
            if (this.mode !== 'codex') {
                return;
            }
            this.currentPatch = result.patch;
            this.renderPatch(result.patch, context);
            this.recordHistoryEntry(result.patch, context, options);
            // Prevent duplicate submissions of the same request. Editing the task
            // field explicitly unlocks Generate patch for the next instruction.
            this.generateLockedUntilInput = true;
            this.updateGenerateButtonState();
            this.setStatus(result.threadId
                ? `Patch ready. Codex thread: ${result.threadId}`
                : 'Patch ready for review.', '● Patch available', 'success');
            if (this.codexAutoApply.checked) {
                await this.applyPatch();
            }
        }
        catch (error) {
            if (this.mode === 'codex') {
                this.setStatus(error instanceof Error ? error.message : String(error), '● Error', 'error');
            }
        }
        finally {
            this.setBusy(false);
        }
    }
    async cancelCodex() {
        await this.codexRunner.cancel();
        this.setStatus('Cancellation requested.', '● Cancelling');
    }
    async parseManualResponse() {
        if (this.mode !== 'chatgpt') {
            return;
        }
        try {
            if (!this.responseInput.value.trim()) {
                throw new Error('Paste a ChatGPT response before parsing it.');
            }
            const options = this.pendingManualOptions
                ? { ...this.pendingManualOptions }
                : { ...this.contextOptions };
            const context = this.pendingManualContext
                ? this.pendingManualContext
                : collectNotebookContext(this.requirePanel(), options);
            const patch = patchFromText(this.responseInput.value);
            this.currentPatch = patch;
            this.patchContext = context;
            this.patchOptions = options;
            this.setDetailsCollapsed(false);
            this.renderPatch(patch, context, true);
            this.recordHistoryEntry(patch, context, options);
            this.setApplyButtonReady(true);
            this.flashButtonSuccess(this.parseButton, 'Parsed', 'Parse pasted response');
            this.setStatus('Pasted ChatGPT response parsed. Review the operations before applying them.', '● Patch available', 'success');
            window.setTimeout(() => {
                this.resultNode.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 0);
            if (this.autoApplyAfterParse.checked) {
                window.setTimeout(() => {
                    if (this.mode === 'chatgpt' && this.currentPatch === patch) {
                        void this.applyPatch();
                    }
                }, 0);
            }
        }
        catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), '● Error', 'error');
        }
    }
    resetConversation() {
        this.historyStore.startNewConversation();
        this.currentHistoryEntryId = null;
        if (this.busy) {
            void this.codexRunner.cancel();
            this.setBusy(false);
        }
        this.currentPatch = null;
        this.patchContext = null;
        this.patchOptions = null;
        this.pendingManualContext = null;
        this.pendingManualOptions = null;
        this.patchApplied = false;
        this.generateLockedUntilInput = false;
        this.updateGenerateButtonState();
        this.responseInput.value = '';
        this.taskInput.value = '';
        this.setDetailsCollapsed(false);
        this.renderEmptyResult();
        this.setApplyButtonReady(false);
        this.setStatus('Conversation cleared.', '● Ready');
        if (this.mode === 'chatgpt') {
            this.resetManualVisualState(true);
        }
        else {
            this.initializeCodexTaskField();
            this.contentNode.scrollTo({ top: 0, behavior: 'smooth' });
            window.setTimeout(() => {
                this.taskInput.focus();
                this.taskInput.select();
            }, 150);
        }
    }
    renderEmptyResult() {
        this.resultNode.replaceChildren();
        this.patchDetailsNode = null;
        this.detailsCollapsed = false;
        const empty = document.createElement('div');
        empty.className = 'jna-ResultEmpty';
        empty.textContent =
            this.mode === 'chatgpt'
                ? 'No ChatGPT response parsed yet. Enter a task, open ChatGPT, and paste the response here.'
                : 'No patch yet. Describe a task and generate a Codex patch.';
        this.resultNode.appendChild(empty);
    }
    rejectPatch() {
        if (!this.currentPatch) {
            this.setStatus('No parsed or generated patch is available.', '● Ready', 'error');
            return;
        }
        this.clearResultState();
        this.setStatus('Patch rejected.', '● Ready');
    }
    setApplyButtonReady(ready) {
        this.applyButton.disabled = !ready;
        this.setButtonState(this.applyButton, ready ? 'ready' : 'neutral', 'Apply');
        this.rejectButton.disabled = !ready;
        this.setButtonState(this.rejectButton, ready ? 'danger' : 'neutral', 'Reject');
    }
    resetAppliedButtonForEditing() {
        if (!this.patchApplied) {
            return;
        }
        this.applyButton.disabled = true;
        this.setButtonState(this.applyButton, 'neutral', 'Apply');
        this.rejectButton.disabled = true;
        this.setButtonState(this.rejectButton, 'neutral', 'Reject');
    }
    syncCurrentHistoryState() {
        if (this.currentHistoryEntryId === null) {
            return;
        }
        const entry = this.historyStore
            .getEntries()
            .find(candidate => candidate.id === this.currentHistoryEntryId);
        if (!entry) {
            return;
        }
        if (entry.state === 'applied') {
            this.patchApplied = true;
            this.undoSnapshot = entry.beforeSnapshot
                ? cloneJson(entry.beforeSnapshot)
                : null;
            this.applyButton.disabled = true;
            this.setButtonState(this.applyButton, 'success', '✓ Applied');
            this.rejectButton.disabled = true;
            this.setButtonState(this.rejectButton, 'neutral', 'Reject');
            return;
        }
        if (entry.state === 'undone') {
            this.patchApplied = false;
            this.undoSnapshot = null;
            this.setApplyButtonReady(Boolean(this.currentPatch));
        }
    }
    recordHistoryEntry(patch, context, options) {
        const position = this.historyStore.nextMessagePosition();
        const entry = this.historyStore.add({
            conversationNumber: position.conversationNumber,
            messageNumber: position.messageNumber,
            timestamp: Date.now(),
            mode: this.mode,
            inputText: this.taskInput.value.trim(),
            patch,
            context,
            options,
            selectedOperationIndexes: patch.operations.map((_operation, index) => index),
            beforeSnapshot: null,
            afterSnapshot: null,
            state: 'generated'
        });
        this.currentHistoryEntryId = entry.id;
    }
    renderPatch(patch, context, deferApplyReady = false) {
        this.resultNode.replaceChildren();
        this.patchApplied = false;
        this.operationChecks = [];
        const summary = document.createElement('div');
        summary.className = 'jna-PatchSummary';
        const strong = document.createElement('strong');
        strong.textContent = 'Summary: ';
        summary.append(strong, document.createTextNode(patch.summary));
        this.resultNode.appendChild(summary);
        const detailsHeader = document.createElement('div');
        detailsHeader.className = 'jna-PatchDetailsHeader';
        const detailsTitle = document.createElement('strong');
        detailsTitle.textContent = 'Diff / changes';
        detailsHeader.append(detailsTitle, this.detailsToggleButton);
        this.resultNode.appendChild(detailsHeader);
        const patchDetailsNode = document.createElement('div');
        patchDetailsNode.className = 'jna-PatchDetails';
        this.patchDetailsNode = patchDetailsNode;
        this.resultNode.appendChild(patchDetailsNode);
        this.setDetailsCollapsed(false);
        const panel = this.panel;
        for (const [index, operation] of patch.operations.entries()) {
            const wrapper = document.createElement('div');
            wrapper.className = 'jna-Operation';
            const header = document.createElement('div');
            header.className = 'jna-OperationHeader';
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.dataset.operationIndex = String(index);
            this.operationChecks.push(checkbox);
            label.append(checkbox, document.createTextNode(` ${operationLabel(operation, context, panel)}`));
            header.appendChild(label);
            wrapper.appendChild(header);
            const targetReference = cellDisplayReference(operation.cell_id, context, panel);
            const destinationReference = cellDisplayReference(operation.reference_cell_id, context, panel);
            if (operation.operation === 'insert_before' || operation.operation === 'insert_after') {
                appendCellReference(wrapper, 'Anchor', targetReference);
            }
            else if (operation.operation === 'move_before' || operation.operation === 'move_after') {
                appendCellReference(wrapper, 'Source', targetReference);
                appendCellReference(wrapper, 'Destination anchor', destinationReference);
            }
            else if (operation.operation !== 'append') {
                appendCellReference(wrapper, 'Target', targetReference);
            }
            if (operation.reason) {
                const reason = document.createElement('div');
                reason.className = 'jna-OperationReason';
                reason.textContent = operation.reason;
                wrapper.appendChild(reason);
            }
            let oldSource = '';
            if (panel && operation.cell_id) {
                const oldCell = panel.content.widgets.find(cell => cell.model.id === operation.cell_id);
                oldSource = oldCell?.model.sharedModel.getSource() ?? '';
            }
            if (operation.operation === 'replace') {
                wrapper.appendChild(lineDiff(oldSource, operation.source));
            }
            else if (operation.operation === 'insert_before' ||
                operation.operation === 'insert_after' ||
                operation.operation === 'append') {
                wrapper.appendChild(lineDiff('', operation.source));
            }
            patchDetailsNode.appendChild(wrapper);
        }
        if (patch.notes.length) {
            const notes = document.createElement('ul');
            for (const note of patch.notes) {
                const item = document.createElement('li');
                item.textContent = note;
                notes.appendChild(item);
            }
            patchDetailsNode.appendChild(notes);
        }
        this.setApplyButtonReady(!deferApplyReady);
        this.patchContext = context;
    }
    currentCellIndex(panel, cellId) {
        return panel.content.model?.sharedModel.cells.findIndex(cell => cell.id === cellId) ?? -1;
    }
    validateOperation(panel, operation, context, options) {
        const validOperations = new Set([
            'replace',
            'insert_before',
            'insert_after',
            'append',
            'delete',
            'move_before',
            'move_after'
        ]);
        if (!validOperations.has(operation.operation)) {
            throw new Error(`Unsupported operation: ${operation.operation}`);
        }
        if (!['code', 'markdown'].includes(operation.cell_type)) {
            throw new Error(`Unsupported cell type: ${operation.cell_type}`);
        }
        const activeId = context.activeCellId;
        const selectedIds = new Set(context.selectedCellIds);
        const structural = operation.operation !== 'replace';
        if (options.editScope === 'active') {
            if (structural || operation.cell_id !== activeId) {
                throw new Error(`Operation “${operationLabel(operation, context, panel)}” exceeds the active-cell-only edit scope.`);
            }
        }
        else if (options.editScope === 'selected') {
            if (structural || !selectedIds.has(operation.cell_id)) {
                throw new Error(`Operation “${operationLabel(operation, context, panel)}” exceeds the selected-cells edit scope.`);
            }
        }
        if (operation.cell_type === 'markdown' &&
            !options.allowMarkdownChanges) {
            throw new Error('The patch changes Markdown, but Markdown changes are disabled.');
        }
        if (['delete', 'move_before', 'move_after'].includes(operation.operation) &&
            !options.allowDeleteMove) {
            throw new Error('The patch deletes or moves cells, but those operations are disabled.');
        }
        if (operation.operation !== 'append') {
            const index = this.currentCellIndex(panel, operation.cell_id);
            if (index < 0) {
                const target = cellDisplayReference(operation.cell_id, context, panel);
                throw new Error(`Target ${target.label} no longer exists.`);
            }
            const original = context.cells.find(cell => cell.id === operation.cell_id);
            if (original) {
                const currentSource = panel.content.widgets[index]?.model.sharedModel.getSource() ?? '';
                if (sourceHash(currentSource) !== original.sourceHash) {
                    throw new Error(`Cell ${original.index + 1} changed after the patch request. Generate the patch again.`);
                }
            }
        }
        if (['move_before', 'move_after'].includes(operation.operation)) {
            if (this.currentCellIndex(panel, operation.reference_cell_id) < 0) {
                const destination = cellDisplayReference(operation.reference_cell_id, context, panel);
                throw new Error(`Destination anchor ${destination.label} no longer exists.`);
            }
        }
    }
    makeCellData(operation) {
        if (operation.cell_type === 'markdown') {
            return {
                cell_type: 'markdown',
                source: operation.source,
                metadata: {}
            };
        }
        return {
            cell_type: 'code',
            source: operation.source,
            metadata: {},
            outputs: [],
            execution_count: null
        };
    }
    async applyOperationsToPanel(panel, patch, context, options, selectedOperationIndexes) {
        const shared = panel.content.model?.sharedModel;
        if (!shared) {
            throw new Error('The target notebook model is unavailable.');
        }
        const selectedOperations = selectedOperationIndexes.map(index => {
            const operation = patch.operations[index];
            if (!operation) {
                throw new Error(`Patch operation ${index + 1} no longer exists.`);
            }
            return operation;
        });
        if (!selectedOperations.length) {
            throw new Error('Select at least one operation to apply.');
        }
        selectedOperations.forEach(operation => this.validateOperation(panel, operation, context, options));
        // Validate the exact post-transport source text before mutating the
        // notebook. This catches malformed model output and accidental text
        // corruption in the parser or terminal-output transport layer.
        const pythonSources = selectedOperations
            .filter(operation => operation.cell_type === 'code' &&
            ['replace', 'insert_before', 'insert_after', 'append'].includes(operation.operation))
            .map(operation => ({
            label: operationLabel(operation, context, panel),
            source: operation.source
        }));
        if (pythonSources.length) {
            this.setStatus(`Validating ${pythonSources.length} modified Python code cell(s)…`, '● Validating syntax');
            const kernelName = panel.sessionContext.session?.kernel?.name || 'python3';
            await this.codexRunner.validatePythonSources(pythonSources, kernelName);
        }
        const beforeSnapshot = cloneJson(shared.toJSON());
        const changedCellIds = new Set();
        shared.transact(() => {
            for (const operation of selectedOperations) {
                const index = operation.cell_id
                    ? shared.cells.findIndex(cell => cell.id === operation.cell_id)
                    : -1;
                if (operation.operation === 'replace') {
                    shared.cells[index].setSource(operation.source);
                    changedCellIds.add(operation.cell_id);
                }
                else if (operation.operation === 'insert_before') {
                    const inserted = shared.insertCell(index, this.makeCellData(operation));
                    changedCellIds.add(inserted.id);
                }
                else if (operation.operation === 'insert_after') {
                    const inserted = shared.insertCell(index + 1, this.makeCellData(operation));
                    changedCellIds.add(inserted.id);
                }
                else if (operation.operation === 'append') {
                    const inserted = shared.addCell(this.makeCellData(operation));
                    changedCellIds.add(inserted.id);
                }
                else if (operation.operation === 'delete') {
                    shared.deleteCell(index);
                }
                else if (operation.operation === 'move_before' ||
                    operation.operation === 'move_after') {
                    const referenceIndex = shared.cells.findIndex(cell => cell.id === operation.reference_cell_id);
                    let destination = operation.operation === 'move_before'
                        ? referenceIndex
                        : referenceIndex + 1;
                    if (index < destination) {
                        destination -= 1;
                    }
                    shared.moveCell(index, destination);
                    changedCellIds.add(operation.cell_id);
                }
            }
        });
        return {
            beforeSnapshot,
            afterSnapshot: cloneJson(shared.toJSON()),
            changedCellIds,
            selectedOperations
        };
    }
    async runChangedCodeCells(panel, changedCellIds) {
        const cellsToRun = panel.content.widgets.filter(cell => changedCellIds.has(cell.model.id) && cell.model.type === 'code');
        if (!cellsToRun.length) {
            return null;
        }
        await new Promise(resolve => window.setTimeout(resolve, 100));
        this.setStatus(`Executing ${cellsToRun.length} modified code cell(s)…`, '● Executing');
        return NotebookActions.runCells(panel.content, cellsToRun, panel.sessionContext);
    }
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
    async applyHistoryEntry(entryId) {
        const entry = this.historyStore
            .getEntries()
            .find(candidate => candidate.id === entryId);
        if (!entry) {
            throw new Error('The selected history entry no longer exists.');
        }
        if (entry.state !== 'generated') {
            throw new Error(entry.state === 'applied'
                ? 'This history patch has already been applied.'
                : 'This history patch was applied and then undone. Use Reapply instead.');
        }
        let panel = null;
        this.tracker.forEach(candidate => {
            if (candidate.context.path === entry.context.notebookName ||
                candidate.title.label === entry.context.notebookName) {
                panel = candidate;
            }
        });
        if (!panel) {
            throw new Error(`Notebook “${entry.context.notebookName}” is not open. Open it before applying this patch.`);
        }
        const selectedOperationIndexes = entry.selectedOperationIndexes.length
            ? entry.selectedOperationIndexes.filter(index => index >= 0 && index < entry.patch.operations.length)
            : entry.patch.operations.map((_operation, index) => index);
        const result = await this.applyOperationsToPanel(panel, entry.patch, entry.context, entry.options, selectedOperationIndexes);
        this.historyStore.update(entry.id, {
            selectedOperationIndexes,
            beforeSnapshot: result.beforeSnapshot,
            afterSnapshot: result.afterSnapshot,
            state: 'applied'
        });
        let message = `Applied ${result.selectedOperations.length} operation(s) from patch ` +
            `${entry.conversationNumber}|${entry.messageNumber}.`;
        if (this.autoRunOnApply.checked) {
            const success = await this.runChangedCodeCells(panel, result.changedCellIds);
            if (success === true) {
                message += ' Modified code cells were executed.';
            }
            else if (success === false) {
                message += ' At least one modified code cell did not complete successfully.';
            }
        }
        if (this.currentHistoryEntryId === entry.id) {
            this.showPatchAppliedBanner();
        }
        this.setStatus(message, '● Applied', 'success');
        return message;
    }
    async applyPatch() {
        if (!this.currentPatch || !this.patchContext || !this.patchOptions) {
            this.setStatus('No parsed or generated patch is available.', '● Ready', 'error');
            return;
        }
        try {
            if (this.patchApplied) {
                throw new Error('This patch has already been applied. Undo it or parse/generate a new patch before applying again.');
            }
            const panel = this.requirePanel();
            const selectedOperationIndexes = this.currentPatch.operations
                .map((_operation, index) => index)
                .filter(index => this.operationChecks[index]?.checked);
            const result = await this.applyOperationsToPanel(panel, this.currentPatch, this.patchContext, this.patchOptions, selectedOperationIndexes);
            this.undoSnapshot = cloneJson(result.beforeSnapshot);
            this.patchApplied = true;
            this.applyButton.disabled = true;
            this.setButtonState(this.applyButton, 'success', '✓ Applied');
            this.rejectButton.disabled = true;
            this.setButtonState(this.rejectButton, 'neutral', 'Reject');
            if (this.undoButton) {
                this.undoButton.disabled = false;
            }
            if (this.currentHistoryEntryId !== null) {
                this.historyStore.update(this.currentHistoryEntryId, {
                    selectedOperationIndexes,
                    beforeSnapshot: result.beforeSnapshot,
                    afterSnapshot: result.afterSnapshot,
                    state: 'applied'
                });
            }
            this.setStatus(`Applied ${result.selectedOperations.length} notebook operation(s).`, '● Applied', 'success');
            this.showPatchAppliedBanner();
            if (this.autoRunOnApply.checked) {
                const success = await this.runChangedCodeCells(panel, result.changedCellIds);
                if (success !== null) {
                    this.setStatus(success
                        ? 'Changes applied and modified cells executed.'
                        : 'Changes applied; at least one modified cell did not complete successfully.', success ? '● Ready' : '● Execution error', success ? 'success' : 'error');
                }
            }
            this.taskInput.value = '';
            if (this.mode === 'chatgpt') {
                this.responseInput.value = '';
                this.resetManualVisualState(true);
            }
            else {
                this.taskInput.dataset.state = 'neutral';
                this.contentNode.scrollTo({ top: 0, behavior: 'smooth' });
                window.setTimeout(() => this.taskInput.focus(), 150);
            }
        }
        catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), '● Error', 'error');
        }
    }
    undoChanges() {
        if (this.currentHistoryEntryId === null) {
            this.setStatus('No applied AI patch is available in the current conversation.', '● Ready', 'error');
            return;
        }
        if (!this.requestHistoryOpen) {
            this.setStatus('Session AI history is unavailable.', '● Error', 'error');
            return;
        }
        this.requestHistoryOpen(this.currentHistoryEntryId);
        this.setStatus('Choose “Restore previous state” or “Replay inverse patch” in Session AI history. Both actions show a diff preview before changing the notebook.', '● Ready', 'success');
    }
    async openUserInstructionsDialog() {
        let draftInstruction = this.userInstruction;
        let draftEnabled = this.includeUserInstruction;
        const body = new Widget();
        body.addClass('jna-ContextDialog');
        const group = document.createElement('div');
        group.className = 'jna-ContextGroup';
        group.appendChild(sectionTitle('User instructions'));
        const enabledLabel = document.createElement('label');
        enabledLabel.className = 'jna-OptionLine';
        const enabledInput = document.createElement('input');
        enabledInput.type = 'checkbox';
        enabledInput.checked = draftEnabled;
        enabledLabel.append(enabledInput, document.createTextNode('Include these instructions in every generated prompt'));
        const instructionInput = document.createElement('textarea');
        instructionInput.className = 'jna-InstructionInput';
        instructionInput.value = draftInstruction;
        instructionInput.spellcheck = true;
        instructionInput.setAttribute('aria-label', 'User instructions for every prompt');
        instructionInput.disabled = !draftEnabled;
        enabledInput.onchange = () => {
            draftEnabled = enabledInput.checked;
            instructionInput.disabled = !draftEnabled;
        };
        instructionInput.oninput = () => {
            draftInstruction = instructionInput.value;
        };
        const help = document.createElement('div');
        help.className = 'jna-ShortcutHelp';
        help.textContent =
            'When enabled, these instructions are added to every Codex prompt, manually copied ChatGPT prompt, and @assistant request. The text and enabled state are stored for future JupyterLab sessions.';
        group.append(enabledLabel, instructionInput, help);
        body.node.appendChild(group);
        const result = await showDialog({
            title: 'User instructions',
            body,
            buttons: [
                Dialog.cancelButton({ label: 'Cancel' }),
                Dialog.okButton({ label: 'Save' })
            ]
        });
        if (!result.button.accept) {
            return;
        }
        this.userInstruction = draftInstruction;
        this.includeUserInstruction = draftEnabled;
        this.persistSettings();
        this.refreshNotebookStatus();
        this.setStatus(this.includeUserInstruction
            ? 'User instructions saved and enabled for all generated prompts.'
            : 'User instructions saved but disabled.', '● Ready', 'success');
    }
    async openContextDialog() {
        let panel;
        try {
            panel = this.requirePanel();
        }
        catch (error) {
            this.setStatus(String(error), '● Error', 'error');
            return;
        }
        const draft = { ...this.contextOptions };
        let draftShortcut = this.assistantShortcut;
        let draftSelectAboveShortcut = this.selectAboveShortcut;
        const body = new Widget();
        body.addClass('jna-ContextDialog');
        const contextGroup = document.createElement('div');
        contextGroup.className = 'jna-ContextGroup';
        contextGroup.appendChild(sectionTitle('Context'));
        const addCheckbox = (labelText, key) => {
            const label = document.createElement('label');
            label.className = 'jna-OptionLine';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.disabled = false;
            input.checked = Boolean(draft[key]);
            input.onchange = () => {
                draft[key] = input.checked;
                updateSummary();
            };
            label.append(input, document.createTextNode(labelText));
            contextGroup.appendChild(label);
            return input;
        };
        addCheckbox('Include active/selected cells', 'includeSelected');
        addCheckbox('Include all cells up to last selected', 'includeBefore');
        addCheckbox('Include relevant errors and outputs', 'includeOutputs');
        addCheckbox('Include cells after the selection', 'includeAfter');
        addCheckbox('Include Markdown cells as context', 'includeMarkdownContext');
        const summary = document.createElement('div');
        summary.className = 'jna-ContextSummary';
        contextGroup.appendChild(summary);
        const inspect = button('Inspect supplied context');
        contextGroup.appendChild(inspect);
        const allowedGroup = document.createElement('div');
        allowedGroup.className = 'jna-ContextGroup';
        allowedGroup.appendChild(sectionTitle('Allowed changes'));
        const radioName = `jna-edit-scope-${Date.now()}-${Math.random()}`;
        const permissionSummary = document.createElement('div');
        permissionSummary.className = 'jna-PermissionSummary';
        const updatePermissionSummary = () => {
            if (draft.editScope === 'active') {
                permissionSummary.textContent =
                    'Effective right: replace only the active cell captured in this context. Adding, deleting, or moving cells is blocked.';
            }
            else if (draft.editScope === 'selected') {
                permissionSummary.textContent =
                    'Effective right: replace any cell that was selected when this context was captured. Adding, deleting, or moving cells is blocked.';
            }
            else {
                const extraRights = [
                    draft.allowMarkdownChanges ? 'change Markdown cells' : '',
                    draft.allowDeleteMove ? 'delete or move cells' : ''
                ].filter(Boolean);
                permissionSummary.textContent =
                    'Effective right: replace any existing cell and insert or append new code cells' +
                        (extraRights.length ? `; also ${extraRights.join(' and ')}` : '') +
                        '.';
            }
        };
        const addRadio = (labelText, value) => {
            const label = document.createElement('label');
            label.className = 'jna-OptionLine jna-PermissionOption';
            const input = document.createElement('input');
            input.type = 'radio';
            input.disabled = false;
            input.name = radioName;
            input.value = value;
            input.checked = draft.editScope === value;
            input.onchange = () => {
                if (input.checked) {
                    draft.editScope = value;
                    updatePermissionSummary();
                }
            };
            label.append(input, document.createTextNode(labelText));
            allowedGroup.appendChild(label);
        };
        addRadio('Active cell only', 'active');
        addRadio('All selected cells', 'selected');
        addRadio('Any cell; may add new cells', 'any');
        allowedGroup.appendChild(permissionSummary);
        const addAllowedCheckbox = (labelText, key) => {
            const label = document.createElement('label');
            label.className = 'jna-OptionLine';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.disabled = false;
            input.checked = draft[key];
            input.onchange = () => {
                draft[key] = input.checked;
                updatePermissionSummary();
            };
            label.append(input, document.createTextNode(labelText));
            allowedGroup.appendChild(label);
        };
        addAllowedCheckbox('Allow changing Markdown cells', 'allowMarkdownChanges');
        addAllowedCheckbox('Allow deleting or moving cells', 'allowDeleteMove');
        const shortcutGroup = document.createElement('div');
        shortcutGroup.className = 'jna-ContextGroup';
        shortcutGroup.appendChild(sectionTitle('Keyboard shortcuts'));
        const shortcutLabel = document.createElement('label');
        shortcutLabel.className = 'jna-ShortcutLabel';
        shortcutLabel.textContent = '@assistant message shortcut';
        const shortcutInput = document.createElement('input');
        shortcutInput.className = 'jna-ShortcutInput';
        shortcutInput.type = 'text';
        shortcutInput.value = draftShortcut;
        shortcutInput.placeholder = 'Ctrl+Q';
        shortcutInput.spellcheck = false;
        shortcutInput.oninput = () => {
            draftShortcut = shortcutInput.value;
        };
        const shortcutHelp = document.createElement('div');
        shortcutHelp.className = 'jna-ShortcutHelp';
        shortcutHelp.textContent =
            'Moves a message such as “# @assistant fix this indexing error” from the active code cell into the task field and starts the current workflow.';
        const selectAboveLabel = document.createElement('label');
        selectAboveLabel.className = 'jna-ShortcutLabel jna-ShortcutLabelSpaced';
        selectAboveLabel.textContent = 'Select active cell and all cells above';
        const selectAboveInput = document.createElement('input');
        selectAboveInput.className = 'jna-ShortcutInput';
        selectAboveInput.type = 'text';
        selectAboveInput.value = draftSelectAboveShortcut;
        selectAboveInput.placeholder = 'Ctrl+Alt+A';
        selectAboveInput.spellcheck = false;
        selectAboveInput.oninput = () => {
            draftSelectAboveShortcut = selectAboveInput.value;
        };
        const selectAboveHelp = document.createElement('div');
        selectAboveHelp.className = 'jna-ShortcutHelp';
        selectAboveHelp.textContent =
            'Selects the current notebook cell and every preceding cell. Ctrl+Shift+A is reserved by Firefox and Chromium browsers and cannot reach JupyterLab; use Ctrl+Alt+A or another unreserved combination. Leave either shortcut field empty to disable that shortcut.';
        shortcutGroup.append(shortcutLabel, shortcutInput, shortcutHelp, selectAboveLabel, selectAboveInput, selectAboveHelp);
        const updateSummary = () => {
            const context = collectNotebookContext(panel, draft);
            const instructionCharacters = this.includeUserInstruction
                ? this.userInstruction.trim().length
                : 0;
            const totalCharacters = context.characterCount + instructionCharacters;
            summary.textContent = `${context.cells.length} cells · ${formatSize(totalCharacters)} · estimated ${Math.ceil(totalCharacters / 4).toLocaleString()} tokens` +
                (this.includeUserInstruction
                    ? ' · user instructions included'
                    : ' · user instructions excluded');
            return context;
        };
        inspect.onclick = () => {
            const preview = new Widget();
            const pre = document.createElement('pre');
            pre.className = 'jna-Preview';
            const context = updateSummary();
            const instructionPreview = this.includeUserInstruction
                ? this.userInstruction.trim() || '[empty instructions]'
                : '[excluded in settings]';
            pre.textContent = [
                `--- USER INSTRUCTIONS ---\n${instructionPreview}`,
                `--- NOTEBOOK CONTEXT ---\n${formatNotebookContext(context)}`
            ].join('\n\n');
            preview.node.appendChild(pre);
            void showDialog({
                title: 'Exact supplied notebook context',
                body: preview,
                buttons: [Dialog.okButton({ label: 'Close' })]
            });
        };
        body.node.append(contextGroup, allowedGroup, shortcutGroup);
        updateSummary();
        updatePermissionSummary();
        const result = await showDialog({
            title: 'Notebook permissions',
            body,
            buttons: [
                Dialog.cancelButton({ label: 'Cancel' }),
                Dialog.okButton({ label: 'Apply' })
            ]
        });
        if (result.button.accept) {
            try {
                this.assistantShortcut = normalizeShortcut(draftShortcut);
                const normalizedSelectAboveShortcut = normalizeShortcut(draftSelectAboveShortcut);
                if (normalizedSelectAboveShortcut === 'Ctrl+Shift+A') {
                    throw new Error('Ctrl+Shift+A is reserved by the browser and cannot reach JupyterLab. Use Ctrl+Alt+A or another shortcut.');
                }
                this.selectAboveShortcut = normalizedSelectAboveShortcut;
            }
            catch (error) {
                this.setStatus(error instanceof Error ? error.message : String(error), '● Error', 'error');
                return;
            }
            this.contextOptions = draft;
            this.persistSettings();
            this.refreshNotebookStatus();
            const shortcutMessages = [
                this.assistantShortcut
                    ? `@assistant: ${this.assistantShortcut}`
                    : '@assistant disabled',
                this.selectAboveShortcut
                    ? `select above: ${this.selectAboveShortcut}`
                    : 'select above disabled'
            ];
            this.setStatus(`Notebook context and permissions saved (${shortcutMessages.join('; ')}).`, '● Ready', 'success');
        }
    }
}
export class SessionHistoryContent extends Widget {
    tracker;
    historyStore;
    requestApply;
    requestClose;
    constructor(tracker, historyStore, requestApply, requestClose) {
        super();
        this.tracker = tracker;
        this.historyStore = historyStore;
        this.requestApply = requestApply;
        this.requestClose = requestClose;
        this.addClass('jna-HistoryRoot');
        this.buildUI();
        this.unsubscribe = this.historyStore.subscribe(() => this.onHistoryChanged());
        this.onHistoryChanged(true);
    }
    currentIndex = -1;
    lastEntryCount = 0;
    unsubscribe = null;
    metadataNode;
    positionNode;
    previousButton;
    nextButton;
    slider;
    contentNode;
    applyNowButton;
    restoreButton;
    replayButton;
    statusNode;
    actionInProgress = false;
    dispose() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        super.dispose();
    }
    buildUI() {
        const header = document.createElement('div');
        header.className = 'jna-HistoryHeader';
        const title = document.createElement('div');
        title.className = 'jna-HistoryTitle';
        title.textContent = 'Session AI history';
        this.metadataNode = document.createElement('div');
        this.metadataNode.className = 'jna-HistoryMetadata';
        header.append(title, this.metadataNode);
        const navigation = document.createElement('div');
        navigation.className = 'jna-HistoryNavigation';
        this.previousButton = button('←', 'jna-Button jna-HistoryArrow', 'Previous patch');
        this.nextButton = button('→', 'jna-Button jna-HistoryArrow', 'Next patch');
        this.slider = document.createElement('input');
        this.slider.type = 'range';
        this.slider.className = 'jna-HistorySlider';
        this.slider.min = '0';
        this.slider.step = '1';
        this.positionNode = document.createElement('div');
        this.positionNode.className = 'jna-HistoryPosition';
        this.previousButton.onclick = () => this.move(-1);
        this.nextButton.onclick = () => this.move(1);
        this.slider.oninput = () => {
            this.currentIndex = Number(this.slider.value);
            this.renderCurrent();
        };
        navigation.append(this.previousButton, this.slider, this.nextButton, this.positionNode);
        this.contentNode = document.createElement('div');
        this.contentNode.className = 'jna-HistoryContent';
        const actions = document.createElement('div');
        actions.className = 'jna-HistoryActions';
        this.applyNowButton = button('Apply now', 'jna-Button', 'Preview and apply this previously generated patch');
        this.restoreButton = button('Restore previous state', 'jna-Button', 'Preview and restore an exact recorded notebook state');
        this.replayButton = button('Replay inverse patch', 'jna-Button', 'Preview and replay only the recorded patch delta');
        this.applyNowButton.onclick = () => void this.applyCurrent();
        this.restoreButton.onclick = () => void this.restoreCurrent();
        this.replayButton.onclick = () => void this.replayCurrent();
        actions.append(this.applyNowButton, this.restoreButton, this.replayButton);
        this.statusNode = document.createElement('div');
        this.statusNode.className = 'jna-HistoryStatus';
        const footer = document.createElement('div');
        footer.className = 'jna-HistoryFooter';
        const closeButton = button('Close');
        closeButton.onclick = () => this.requestClose?.();
        footer.appendChild(closeButton);
        this.node.append(header, navigation, this.contentNode, actions, this.statusNode, footer);
    }
    onHistoryChanged(selectNewest = false) {
        const entries = this.historyStore.getEntries();
        const newEntryAdded = entries.length > this.lastEntryCount;
        this.lastEntryCount = entries.length;
        if (!entries.length) {
            this.currentIndex = -1;
        }
        else if (selectNewest || newEntryAdded || this.currentIndex < 0) {
            this.currentIndex = entries.length - 1;
        }
        else {
            this.currentIndex = Math.min(this.currentIndex, entries.length - 1);
        }
        this.slider.max = String(Math.max(entries.length - 1, 0));
        this.slider.value = String(Math.max(this.currentIndex, 0));
        this.renderCurrent();
    }
    move(offset) {
        const entries = this.historyStore.getEntries();
        if (!entries.length || this.actionInProgress) {
            return;
        }
        this.currentIndex = Math.max(0, Math.min(entries.length - 1, this.currentIndex + offset));
        this.slider.value = String(this.currentIndex);
        this.renderCurrent();
    }
    currentEntry() {
        return this.historyStore.getEntries()[this.currentIndex] ?? null;
    }
    /**
     * Select a history entry when the history tab is opened from a specific
     * patch action in the assistant sidebar.
     *
     * @param entryId - Internal ID of the history entry to display.
     */
    selectEntry(entryId) {
        const index = this.historyStore
            .getEntries()
            .findIndex(entry => entry.id === entryId);
        if (index < 0) {
            return;
        }
        this.currentIndex = index;
        this.slider.value = String(index);
        this.renderCurrent();
    }
    renderCurrent() {
        const entries = this.historyStore.getEntries();
        const entry = this.currentIndex >= 0 ? entries[this.currentIndex] : null;
        this.contentNode.replaceChildren();
        this.statusNode.textContent = '';
        this.statusNode.dataset.level = '';
        if (!entry) {
            this.metadataNode.textContent = 'No patches in this JupyterLab session';
            this.positionNode.textContent = '0 / 0';
            this.previousButton.disabled = true;
            this.nextButton.disabled = true;
            this.slider.disabled = true;
            this.applyNowButton.disabled = true;
            this.restoreButton.disabled = true;
            this.replayButton.disabled = true;
            this.applyNowButton.hidden = false;
            this.restoreButton.hidden = true;
            this.replayButton.hidden = true;
            const empty = document.createElement('div');
            empty.className = 'jna-HistoryEmpty';
            empty.textContent = 'Generated and parsed patches will appear here.';
            this.contentNode.appendChild(empty);
            return;
        }
        const timestamp = new Date(entry.timestamp).toLocaleString();
        this.metadataNode.textContent = `${timestamp} · ${entry.conversationNumber}|${entry.messageNumber}`;
        this.positionNode.textContent = `${this.currentIndex + 1} / ${entries.length}`;
        this.previousButton.disabled = this.actionInProgress || this.currentIndex <= 0;
        this.nextButton.disabled =
            this.actionInProgress || this.currentIndex >= entries.length - 1;
        this.slider.disabled = this.actionInProgress || entries.length <= 1;
        const generated = entry.state === 'generated';
        const applied = entry.state === 'applied';
        this.applyNowButton.hidden = !generated;
        this.restoreButton.hidden = generated;
        this.replayButton.hidden = generated;
        this.applyNowButton.disabled =
            this.actionInProgress || !generated || this.requestApply === undefined;
        this.applyNowButton.dataset.state =
            generated && this.requestApply !== undefined ? 'ready' : 'neutral';
        if (!generated) {
            this.restoreButton.textContent = applied
                ? 'Restore previous state'
                : 'Restore applied state';
            this.restoreButton.title = applied
                ? 'Replace the current notebook with the exact state recorded before this patch'
                : 'Replace the current notebook with the exact state recorded after this patch';
            this.restoreButton.disabled =
                this.actionInProgress ||
                    (applied ? entry.beforeSnapshot === null : entry.afterSnapshot === null);
            this.replayButton.textContent = applied
                ? 'Replay inverse patch'
                : 'Replay patch';
            this.replayButton.title = applied
                ? 'Undo only the recorded patch operations while retaining unrelated later edits'
                : 'Replay only the recorded patch operations on the current notebook';
            this.replayButton.disabled =
                this.actionInProgress ||
                    entry.beforeSnapshot === null ||
                    entry.afterSnapshot === null;
        }
        const state = document.createElement('div');
        state.className = 'jna-HistoryEntryState';
        state.dataset.state = entry.state;
        state.textContent =
            entry.state === 'applied'
                ? 'Applied'
                : entry.state === 'undone'
                    ? 'Undone'
                    : 'Generated';
        const inputSection = document.createElement('section');
        inputSection.className = 'jna-HistorySection';
        inputSection.appendChild(sectionTitle('Input text'));
        const input = document.createElement('pre');
        input.className = 'jna-HistoryInput';
        input.textContent = entry.inputText || '(empty input)';
        inputSection.appendChild(input);
        const patchSection = document.createElement('section');
        patchSection.className = 'jna-HistorySection';
        patchSection.appendChild(sectionTitle('Patch'));
        const summary = document.createElement('div');
        summary.className = 'jna-PatchSummary';
        const summaryLabel = document.createElement('strong');
        summaryLabel.textContent = 'Summary: ';
        summary.append(summaryLabel, document.createTextNode(entry.patch.summary));
        patchSection.appendChild(summary);
        for (const [index, operation] of entry.patch.operations.entries()) {
            const wrapper = document.createElement('div');
            wrapper.className = 'jna-Operation';
            const heading = document.createElement('div');
            heading.className = 'jna-OperationHeader';
            const label = document.createElement('strong');
            label.textContent = `${index + 1}. ${operationLabel(operation, entry.context, null)}`;
            heading.appendChild(label);
            wrapper.appendChild(heading);
            const targetReference = cellDisplayReference(operation.cell_id, entry.context, null);
            const destinationReference = cellDisplayReference(operation.reference_cell_id, entry.context, null);
            if (operation.operation === 'insert_before' ||
                operation.operation === 'insert_after') {
                appendCellReference(wrapper, 'Anchor', targetReference);
            }
            else if (operation.operation === 'move_before' ||
                operation.operation === 'move_after') {
                appendCellReference(wrapper, 'Source', targetReference);
                appendCellReference(wrapper, 'Destination anchor', destinationReference);
            }
            else if (operation.operation !== 'append') {
                appendCellReference(wrapper, 'Target', targetReference);
            }
            if (operation.reason) {
                const reason = document.createElement('div');
                reason.className = 'jna-OperationReason';
                reason.textContent = operation.reason;
                wrapper.appendChild(reason);
            }
            const oldSource = entry.context.cells.find(cell => cell.id === operation.cell_id)?.source ?? '';
            if (operation.operation === 'replace') {
                wrapper.appendChild(lineDiff(oldSource, operation.source));
            }
            else if (operation.operation === 'insert_before' ||
                operation.operation === 'insert_after' ||
                operation.operation === 'append') {
                wrapper.appendChild(lineDiff('', operation.source));
            }
            patchSection.appendChild(wrapper);
        }
        if (entry.patch.notes.length) {
            const notes = document.createElement('ul');
            for (const note of entry.patch.notes) {
                const item = document.createElement('li');
                item.textContent = note;
                notes.appendChild(item);
            }
            patchSection.appendChild(notes);
        }
        this.contentNode.append(state, inputSection, patchSection);
    }
    findNotebook(entry) {
        let match = null;
        this.tracker.forEach(panel => {
            if (panel.context.path === entry.context.notebookName ||
                panel.title.label === entry.context.notebookName) {
                match = panel;
            }
        });
        return match;
    }
    requireNotebook(entry) {
        const panel = this.findNotebook(entry);
        if (!panel?.content.model?.sharedModel) {
            throw new Error(`Notebook “${entry.context.notebookName}” is not open. Open it before using this history action.`);
        }
        return panel;
    }
    snapshotPanel(panel) {
        const shared = panel.content.model?.sharedModel;
        if (!shared) {
            throw new Error('The notebook model is unavailable.');
        }
        return readNotebookSnapshot(cloneJson(shared.toJSON()));
    }
    ensureNotebookUnchanged(panel, expectedFingerprint) {
        const currentFingerprint = notebookSnapshotFingerprint(this.snapshotPanel(panel));
        if (currentFingerprint !== expectedFingerprint) {
            throw new Error('The notebook changed while the preview was open. Open the preview again before confirming.');
        }
    }
    async confirmChange(title, description, currentSnapshot, targetSnapshot, confirmLabel, destructive, warning) {
        const body = new Widget();
        body.addClass('jna-HistoryPreviewDialog');
        const descriptionNode = document.createElement('div');
        descriptionNode.className = 'jna-HistoryPreviewDescription';
        descriptionNode.textContent = description;
        body.node.appendChild(descriptionNode);
        if (warning) {
            const warningNode = document.createElement('div');
            warningNode.className = destructive
                ? 'jna-HistoryPreviewWarning jna-HistoryPreviewWarningDestructive'
                : 'jna-HistoryPreviewWarning';
            warningNode.textContent = warning;
            body.node.appendChild(warningNode);
        }
        const heading = sectionTitle('Preview: current notebook → result');
        body.node.append(heading, notebookSnapshotDiff(currentSnapshot, targetSnapshot));
        const result = await showDialog({
            title,
            body,
            buttons: [
                Dialog.cancelButton({ label: 'Cancel' }),
                destructive
                    ? Dialog.warnButton({ label: confirmLabel })
                    : Dialog.okButton({ label: confirmLabel })
            ]
        });
        return result.button.accept;
    }
    setActionsBusy(busy) {
        this.actionInProgress = busy;
        this.renderCurrent();
    }
    finishAction() {
        const message = this.statusNode.textContent ?? '';
        const error = this.statusNode.dataset.level === 'error';
        this.actionInProgress = false;
        this.renderCurrent();
        if (message) {
            this.setStatus(message, error);
        }
    }
    /**
     * Preview and apply the currently displayed patch that has not yet been
     * applied. The final mutation still uses the assistant's normal validation
     * path after the user confirms the calculated notebook diff.
     */
    async applyCurrent() {
        const entry = this.currentEntry();
        if (!entry || entry.state !== 'generated') {
            return;
        }
        if (!this.requestApply) {
            this.setStatus('Applying patches from history is unavailable.', true);
            return;
        }
        this.setActionsBusy(true);
        try {
            const panel = this.requireNotebook(entry);
            const currentSnapshot = this.snapshotPanel(panel);
            const selectedOperationIndexes = entry.selectedOperationIndexes.length
                ? entry.selectedOperationIndexes.filter(index => index >= 0 && index < entry.patch.operations.length)
                : entry.patch.operations.map((_operation, index) => index);
            const targetSnapshot = simulatePatchOnSnapshot(currentSnapshot, entry.patch, selectedOperationIndexes, `jna-history-preview-${entry.id}`);
            const fingerprint = notebookSnapshotFingerprint(currentSnapshot);
            const confirmed = await this.confirmChange(`Apply patch ${entry.conversationNumber}|${entry.messageNumber}?`, 'This patch has not been applied yet. The preview is calculated against the notebook as it is now.', currentSnapshot, targetSnapshot, 'Apply now', false, 'Cell permissions, original source hashes, and Python syntax are checked again after confirmation.');
            if (!confirmed) {
                this.setStatus('Patch application cancelled.', false);
                return;
            }
            this.ensureNotebookUnchanged(panel, fingerprint);
            const message = await this.requestApply(entry.id);
            this.setStatus(message, false);
        }
        catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), true);
        }
        finally {
            this.finishAction();
        }
    }
    /**
     * Preview and restore the complete recorded notebook state before or after
     * the selected patch. This exact restoration intentionally replaces every
     * intervening notebook edit represented in the preview.
     */
    async restoreCurrent() {
        const entry = this.currentEntry();
        if (!entry || entry.state === 'generated') {
            return;
        }
        this.setActionsBusy(true);
        try {
            const restoreBefore = entry.state === 'applied';
            const storedSnapshot = restoreBefore
                ? entry.beforeSnapshot
                : entry.afterSnapshot;
            if (storedSnapshot === null) {
                throw new Error(restoreBefore
                    ? 'The recorded state before this patch is no longer stored.'
                    : 'The recorded state after this patch is no longer stored.');
            }
            const panel = this.requireNotebook(entry);
            const shared = panel.content.model?.sharedModel;
            if (!shared) {
                throw new Error('The notebook model is unavailable.');
            }
            const currentSnapshot = this.snapshotPanel(panel);
            const targetSnapshot = readNotebookSnapshot(cloneJson(storedSnapshot));
            const fingerprint = notebookSnapshotFingerprint(currentSnapshot);
            const confirmed = await this.confirmChange(restoreBefore
                ? `Restore state before patch ${entry.conversationNumber}|${entry.messageNumber}?`
                : `Restore state after patch ${entry.conversationNumber}|${entry.messageNumber}?`, restoreBefore
                ? 'The complete notebook will be returned to the exact state recorded immediately before this patch was applied.'
                : 'The complete notebook will be returned to the exact state recorded immediately after this patch was applied.', currentSnapshot, targetSnapshot, restoreBefore ? 'Restore previous state' : 'Restore applied state', true, 'This is a full-state restoration. All notebook edits made after the recorded state—including unrelated edits—will be replaced.');
            if (!confirmed) {
                this.setStatus('Notebook restoration cancelled.', false);
                return;
            }
            this.ensureNotebookUnchanged(panel, fingerprint);
            shared.fromJSON(cloneJson(targetSnapshot));
            this.historyStore.update(entry.id, {
                state: restoreBefore ? 'undone' : 'applied'
            });
            this.setStatus(restoreBefore
                ? `Restored the complete state before patch ${entry.conversationNumber}|${entry.messageNumber}.`
                : `Restored the complete state after patch ${entry.conversationNumber}|${entry.messageNumber}.`, false);
        }
        catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), true);
        }
        finally {
            this.finishAction();
        }
    }
    /**
     * Preview and replay only the recorded patch delta in the forward or inverse
     * direction. Unrelated current edits are retained, while cells touched by
     * the patch can still be overwritten, inserted, deleted, or moved.
     */
    async replayCurrent() {
        const entry = this.currentEntry();
        if (!entry || entry.state === 'generated') {
            return;
        }
        this.setActionsBusy(true);
        try {
            if (entry.beforeSnapshot === null || entry.afterSnapshot === null) {
                throw new Error('The before/after snapshots needed to replay this patch are no longer stored.');
            }
            const inverse = entry.state === 'applied';
            const sourceSnapshot = inverse
                ? entry.afterSnapshot
                : entry.beforeSnapshot;
            const targetSnapshot = inverse
                ? entry.beforeSnapshot
                : entry.afterSnapshot;
            const panel = this.requireNotebook(entry);
            const shared = panel.content.model?.sharedModel;
            if (!shared) {
                throw new Error('The notebook model is unavailable.');
            }
            const currentSnapshot = this.snapshotPanel(panel);
            const replayedSnapshot = replaySnapshotDelta(currentSnapshot, sourceSnapshot, targetSnapshot);
            const fingerprint = notebookSnapshotFingerprint(currentSnapshot);
            const confirmed = await this.confirmChange(inverse
                ? `Replay inverse patch ${entry.conversationNumber}|${entry.messageNumber}?`
                : `Replay patch ${entry.conversationNumber}|${entry.messageNumber}?`, inverse
                ? 'Only the recorded patch operations will be reversed on top of the current notebook.'
                : 'Only the recorded patch operations will be replayed on top of the current notebook.', currentSnapshot, replayedSnapshot, inverse ? 'Replay inverse patch' : 'Replay patch', true, 'Unrelated current edits are retained. Sources and structural changes touched by this patch are overwritten or replayed and may leave the notebook inconsistent; review the diff carefully.');
            if (!confirmed) {
                this.setStatus('Patch replay cancelled.', false);
                return;
            }
            this.ensureNotebookUnchanged(panel, fingerprint);
            shared.fromJSON(cloneJson(replayedSnapshot));
            this.historyStore.update(entry.id, {
                state: inverse ? 'undone' : 'applied'
            });
            this.setStatus(inverse
                ? `Replayed the inverse of patch ${entry.conversationNumber}|${entry.messageNumber} while retaining unrelated current edits.`
                : `Replayed patch ${entry.conversationNumber}|${entry.messageNumber} while retaining unrelated current edits.`, false);
        }
        catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), true);
        }
        finally {
            this.finishAction();
        }
    }
    setStatus(message, error) {
        this.statusNode.textContent = message;
        this.statusNode.dataset.level = error ? 'error' : 'success';
    }
}
export function createHistoryMainWidget(content) {
    const widget = new MainAreaWidget({ content });
    widget.id = 'jupyter-notebook-assistant-history';
    widget.title.label = 'Session AI history';
    widget.title.caption = 'Patches generated in this JupyterLab session';
    widget.title.closable = true;
    return widget;
}
export function createAssistantMainWidget(content) {
    const widget = new MainAreaWidget({ content });
    widget.id = 'jupyter-notebook-assistant-main';
    widget.title.label = 'Assistant';
    widget.title.caption = 'Jupyter Notebook Assistant';
    widget.title.closable = true;
    return widget;
}
//# sourceMappingURL=widgets.js.map