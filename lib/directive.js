const MODIFIER_ALIASES = {
    ctrl: 'ctrl',
    control: 'ctrl',
    alt: 'alt',
    option: 'alt',
    shift: 'shift',
    meta: 'meta',
    cmd: 'meta',
    command: 'meta',
    super: 'meta'
};
const DISPLAY_KEYS = {
    escape: 'Escape',
    enter: 'Enter',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    insert: 'Insert',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight'
};
function normalizeKeyName(value) {
    const key = value.trim().toLowerCase();
    if (key === 'space' || key === 'spacebar') {
        return ' ';
    }
    if (key === 'esc') {
        return 'escape';
    }
    if (key === 'return') {
        return 'enter';
    }
    return key;
}
function shortcutTokens(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return [];
    }
    const separator = trimmed.includes('+') ? /\s*\+\s*/u : /\s*-\s*/u;
    return trimmed.split(separator).map(token => token.trim()).filter(Boolean);
}
export function normalizeShortcut(value) {
    const tokens = shortcutTokens(value);
    if (!tokens.length) {
        return '';
    }
    const modifiers = new Set();
    let key = '';
    for (const token of tokens) {
        const modifier = MODIFIER_ALIASES[token.toLowerCase()];
        if (modifier) {
            modifiers.add(modifier);
        }
        else if (!key) {
            key = normalizeKeyName(token);
        }
        else {
            throw new Error(`Invalid shortcut “${value}”. Use a form such as Ctrl+Q.`);
        }
    }
    if (!key) {
        throw new Error(`Invalid shortcut “${value}”. Add a non-modifier key.`);
    }
    const parts = [];
    if (modifiers.has('ctrl')) {
        parts.push('Ctrl');
    }
    if (modifiers.has('alt')) {
        parts.push('Alt');
    }
    if (modifiers.has('shift')) {
        parts.push('Shift');
    }
    if (modifiers.has('meta')) {
        parts.push('Meta');
    }
    const displayKey = key === ' '
        ? 'Space'
        : key.length === 1
            ? key.toUpperCase()
            : DISPLAY_KEYS[key] ?? key;
    parts.push(displayKey);
    return parts.join('+');
}
export function matchesShortcut(event, shortcut) {
    const normalized = normalizeShortcut(shortcut);
    if (!normalized) {
        return false;
    }
    const tokens = normalized.split('+');
    const expectedKey = normalizeKeyName(tokens[tokens.length - 1]);
    const expectedModifiers = new Set(tokens.slice(0, -1).map(token => token.toLowerCase()));
    return (event.ctrlKey === expectedModifiers.has('ctrl') &&
        event.altKey === expectedModifiers.has('alt') &&
        event.shiftKey === expectedModifiers.has('shift') &&
        event.metaKey === expectedModifiers.has('meta') &&
        normalizeKeyName(event.key) === expectedKey);
}
function findCommentStart(line) {
    let quote = null;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote) {
            if (escaped) {
                escaped = false;
            }
            else if (character === '\\') {
                escaped = true;
            }
            else if (character === quote) {
                quote = null;
            }
            continue;
        }
        if (character === "'" || character === '"') {
            quote = character;
            continue;
        }
        if (character === '#') {
            return { index, markerLength: 1 };
        }
        if (line.startsWith('//', index) || line.startsWith('--', index)) {
            return { index, markerLength: 2 };
        }
    }
    return null;
}
export function extractAssistantDirective(source) {
    const outputLines = [];
    const messages = [];
    let changed = false;
    for (const line of source.split('\n')) {
        const comment = findCommentStart(line);
        if (!comment) {
            outputLines.push(line);
            continue;
        }
        const commentText = line.slice(comment.index + comment.markerLength);
        const directive = commentText.match(/@assistant\b([\s\S]*)/i);
        if (!directive) {
            outputLines.push(line);
            continue;
        }
        const message = directive[1].trim();
        if (!message) {
            outputLines.push(line);
            continue;
        }
        messages.push(message);
        changed = true;
        const codeBeforeComment = line.slice(0, comment.index).replace(/[ \t]+$/u, '');
        if (codeBeforeComment) {
            outputLines.push(codeBeforeComment);
        }
    }
    if (!changed || !messages.length) {
        return null;
    }
    return {
        message: messages.join('\n'),
        cleanedSource: outputLines.join('\n')
    };
}
//# sourceMappingURL=directive.js.map