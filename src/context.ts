import type { CodeCellModel } from '@jupyterlab/cells';
import type { NotebookPanel } from '@jupyterlab/notebook';
import type * as nbformat from '@jupyterlab/nbformat';

import {
  ContextOptions,
  NotebookCellContext,
  NotebookContext
} from './types';

export function sourceHash(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function textFromMimeBundle(data: nbformat.IMimeBundle): string {
  const plain = data['text/plain'];
  if (typeof plain === 'string') {
    return plain;
  }
  if (Array.isArray(plain)) {
    return plain.join('');
  }
  return '';
}

function outputToText(output: nbformat.IOutput): string {
  if (output.output_type === 'error') {
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.join('\n')
      : '';
    return [
      `[error] ${output.ename}: ${output.evalue}`,
      traceback
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (output.output_type === 'stream') {
    const text = Array.isArray(output.text) ? output.text.join('') : output.text;
    return `[${output.name}]\n${text ?? ''}`;
  }

  if (output.output_type === 'execute_result') {
    return `[execute_result]\n${textFromMimeBundle((output.data ?? {}) as nbformat.IMimeBundle)}`;
  }

  if (output.output_type === 'display_data') {
    const plain = textFromMimeBundle((output.data ?? {}) as nbformat.IMimeBundle);
    return plain
      ? `[display_data]\n${plain}`
      : '[display_data omitted: no text/plain representation]';
  }

  return '';
}

function collectOutputText(model: CodeCellModel, maxChars: number): string {
  const outputBlocks = (model.outputs.toJSON() as nbformat.IOutput[])
    .map(outputToText)
    .filter(Boolean);
  const combined = outputBlocks.join('\n\n');
  if (combined.length <= maxChars) {
    return combined;
  }
  return `${combined.slice(0, maxChars)}\n\n[output truncated at ${maxChars} characters]`;
}


export function countNotebookContextCells(
  panel: NotebookPanel,
  options: ContextOptions
): number {
  const notebook = panel.content;
  const activeIndex = notebook.activeCellIndex;
  const selectedIndexes = notebook.widgets
    .map((cell, index) => (notebook.isSelectedOrActive(cell) ? index : -1))
    .filter(index => index >= 0);
  const lastSelected = selectedIndexes.length
    ? Math.max(...selectedIndexes)
    : Math.max(activeIndex, 0);
  const includedIndexes = new Set<number>();

  if (options.includeSelected) {
    selectedIndexes.forEach(index => includedIndexes.add(index));
    if (activeIndex >= 0) {
      includedIndexes.add(activeIndex);
    }
  }
  if (options.includeBefore) {
    for (let index = 0; index < lastSelected; index += 1) {
      includedIndexes.add(index);
    }
  }
  if (options.includeAfter) {
    for (let index = lastSelected + 1; index < notebook.widgets.length; index += 1) {
      includedIndexes.add(index);
    }
  }

  let count = 0;
  for (const index of includedIndexes) {
    const cell = notebook.widgets[index];
    if (!cell) {
      continue;
    }
    if (cell.model.type === 'markdown' && !options.includeMarkdownContext) {
      continue;
    }
    count += 1;
  }
  return count;
}

export function collectNotebookContext(
  panel: NotebookPanel,
  options: ContextOptions
): NotebookContext {
  const notebook = panel.content;
  const activeIndex = notebook.activeCellIndex;
  const selectedIndexes = notebook.widgets
    .map((cell, index) => (notebook.isSelectedOrActive(cell) ? index : -1))
    .filter(index => index >= 0);

  const selectedSet = new Set(selectedIndexes);
  const lastSelected = selectedIndexes.length
    ? Math.max(...selectedIndexes)
    : Math.max(activeIndex, 0);

  const includedIndexes = new Set<number>();
  if (options.includeSelected) {
    selectedIndexes.forEach(index => includedIndexes.add(index));
    if (activeIndex >= 0) {
      includedIndexes.add(activeIndex);
    }
  }
  if (options.includeBefore) {
    for (let index = 0; index < lastSelected; index += 1) {
      includedIndexes.add(index);
    }
  }
  if (options.includeAfter) {
    for (let index = lastSelected + 1; index < notebook.widgets.length; index += 1) {
      includedIndexes.add(index);
    }
  }

  const cells: NotebookCellContext[] = [];
  for (const index of [...includedIndexes].sort((a, b) => a - b)) {
    const cell = notebook.widgets[index];
    if (!cell) {
      continue;
    }
    const cellType = cell.model.type as 'code' | 'markdown' | 'raw';
    if (cellType === 'markdown' && !options.includeMarkdownContext) {
      continue;
    }
    const source = cell.model.sharedModel.getSource();
    let outputText = '';
    let executionCount: number | null = null;
    if (cellType === 'code') {
      const codeModel = cell.model as CodeCellModel;
      executionCount = codeModel.executionCount ?? null;
      if (options.includeOutputs) {
        outputText = collectOutputText(codeModel, options.maxTextOutputChars);
      }
    }
    cells.push({
      id: cell.model.id,
      index,
      cellType,
      source,
      sourceHash: sourceHash(source),
      active: index === activeIndex,
      selected: selectedSet.has(index),
      executionCount,
      outputText
    });
  }

  const characterCount = cells.reduce(
    (sum, cell) => sum + cell.source.length + cell.outputText.length,
    0
  );

  return {
    notebookName: panel.context.path || panel.title.label || 'Untitled.ipynb',
    activeCellIndex: activeIndex,
    activeCellId: notebook.widgets[activeIndex]?.model.id ?? '',
    selectedCellIndexes: selectedIndexes,
    selectedCellIds: selectedIndexes
      .map(index => notebook.widgets[index]?.model.id)
      .filter((id): id is string => Boolean(id)),
    cells,
    characterCount,
    estimatedTokens: Math.ceil(characterCount / 4)
  };
}

export function editPolicyDescription(options: ContextOptions): string {
  if (options.editScope === 'active') {
    return [
      'Only the active cell captured with this request may be replaced.',
      'Do not insert, append, delete, or move cells.'
    ].join(' ');
  }
  if (options.editScope === 'selected') {
    return [
      'Only cells selected when this request was created may be replaced.',
      'Do not insert, append, delete, or move cells.'
    ].join(' ');
  }
  const allowances = [
    'Any existing cell may be replaced.',
    'New code cells may be inserted or appended.'
  ];
  if (options.allowMarkdownChanges) {
    allowances.push('Markdown cells may be changed or added.');
  } else {
    allowances.push('Do not change or add Markdown cells.');
  }
  if (options.allowDeleteMove) {
    allowances.push('Cells may be deleted or moved when necessary.');
  } else {
    allowances.push('Do not delete or move cells.');
  }
  return allowances.join(' ');
}

export function formatNotebookContext(context: NotebookContext): string {
  return context.cells
    .map(cell => {
      const markers = [
        cell.active ? 'ACTIVE' : '',
        cell.selected ? 'SELECTED' : ''
      ].filter(Boolean);
      const markerText = markers.length ? `, ${markers.join(', ')}` : '';
      const execution =
        cell.cellType === 'code'
          ? `, execution_count=${cell.executionCount ?? 'null'}`
          : '';
      const output = cell.outputText
        ? `\n\n--- OUTPUT OF CELL ${cell.index} ---\n${cell.outputText}`
        : '';
      return [
        `--- CELL ${cell.index} [id=${cell.id}, ${cell.cellType}${execution}${markerText}, source_hash=${cell.sourceHash}] ---`,
        cell.source,
        output
      ].join('\n');
    })
    .join('\n\n');
}

export function buildAssistantPrompt(
  task: string,
  context: NotebookContext,
  options: ContextOptions,
  manualMode: boolean,
  userInstruction = ''
): string {
  const selectedIds = context.selectedCellIds.join(', ') || '(none)';
  // Keep persistent user guidance separate from the task so the model receives it consistently.
  const trimmedUserInstruction = userInstruction.trim();
  const userInstructionBlock = trimmedUserInstruction
    ? `\nUSER INSTRUCTIONS\n${trimmedUserInstruction}\n`
    : '';
  const responseInstruction = manualMode
    ? [
        'Return a short explanation followed by exactly one JSON object inside',
        '<jupyter_patch> and </jupyter_patch> tags. Do not include another JSON object. ',
        'The content between the tags must be strict valid JSON: escape every double quote and ',
        'every backslash inside source strings (for example, Python r"$\\pi$" must appear ',
        'inside JSON as r\\\"$\\\\pi$\\\").'
      ].join(' ')
    : 'Return only the structured response required by the supplied JSON schema.';

  return `You are editing a Python Jupyter notebook through a controlled notebook patch interface.

TASK
${task.trim() || 'Review the selected notebook cell(s) and make the most appropriate correction.'}

NOTEBOOK
Name: ${context.notebookName}
Active cell index: ${context.activeCellIndex}
Active cell ID: ${context.activeCellId || '(none)'}
Selected cell indices: ${context.selectedCellIndexes.join(', ') || '(none)'}
Selected cell IDs: ${selectedIds}

EDIT POLICY
${editPolicyDescription(options)}
Make only changes that are necessary for the task. Preserve unrelated code and explanations.
Never claim that you executed notebook code.
${userInstructionBlock}
PATCH FORMAT
The response object must have:
- summary: string
- operations: array
- notes: array of strings
Each operation must have all of these fields:
- operation: one of replace, insert_before, insert_after, append, delete, move_before, move_after
- cell_id: target cell ID, or an empty string only for append
- reference_cell_id: destination/reference cell ID for move operations, otherwise empty string
- cell_type: code or markdown
- source: complete replacement/new cell source; empty only for delete or move
- reason: concise reason
${responseInstruction}

NOTEBOOK CONTEXT
${formatNotebookContext(context)}
`;
}
