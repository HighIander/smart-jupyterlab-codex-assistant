import { ICommandPalette, ToolbarButton } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { LabIcon } from '@jupyterlab/ui-components';
import { AssistantContent, SessionHistoryContent, SessionHistoryStore, createAssistantMainWidget, createHistoryMainWidget } from './widgets';
import { extractAssistantDirective, matchesShortcut } from './directive';
import { getConfiguredShortcut, getSelectAboveShortcut } from './settings';
const COMMAND_ID = 'jupyter-notebook-assistant:open';
const assistantIcon = new LabIcon({
    name: 'jupyter-notebook-assistant:icon',
    svgstr: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v1.08A7.002 7.002 0 0 1 19 11v5a3 3 0 0 1-3 3h-1.17l.75 1.5A1 1 0 0 1 14.68 22H9.32a1 1 0 0 1-.9-1.5l.75-1.5H8a3 3 0 0 1-3-3v-5a7.002 7.002 0 0 1 6-6.92V3a1 1 0 0 1 1-1Zm-4 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-6.5 5a1 1 0 0 0 0 2h5a1 1 0 1 0 0-2h-5Z"/>
</svg>`
});
const plugin = {
    id: 'jupyter-notebook-assistant:plugin',
    description: 'Notebook-aware Codex and manual ChatGPT assistant',
    autoStart: true,
    requires: [INotebookTracker, ICommandPalette],
    activate: (app, notebooks, palette) => {
        let assistantWidget = null;
        let historyWidget = null;
        const historyStore = new SessionHistoryStore();
        const activateAssistant = () => {
            app.shell.expandRight();
            if (assistantWidget && !assistantWidget.isDisposed) {
                app.shell.activateById(assistantWidget.id);
            }
        };
        const openHistory = (entryId) => {
            if (!historyWidget || historyWidget.isDisposed) {
                const content = new SessionHistoryContent(notebooks, historyStore, async (entryId) => {
                    const assistant = assistantWidget && !assistantWidget.isDisposed
                        ? assistantWidget.content
                        : openAssistant();
                    return assistant.applyHistoryEntry(entryId);
                }, () => historyWidget?.close());
                historyWidget = createHistoryMainWidget(content);
                historyWidget.disposed.connect(() => {
                    historyWidget = null;
                });
                app.shell.add(historyWidget, 'main', { mode: 'tab-after' });
            }
            app.shell.activateById(historyWidget.id);
            if (entryId !== undefined) {
                historyWidget.content.selectEntry(entryId);
            }
        };
        const openAssistant = () => {
            if (!assistantWidget || assistantWidget.isDisposed) {
                const content = new AssistantContent(notebooks, app.serviceManager, activateAssistant, historyStore, openHistory);
                assistantWidget = createAssistantMainWidget(content);
                assistantWidget.title.icon = assistantIcon;
                assistantWidget.node.style.minWidth = '180px';
                assistantWidget.node.style.width = '300px';
                assistantWidget.disposed.connect(() => {
                    assistantWidget = null;
                });
                app.shell.add(assistantWidget, 'right', { rank: 1000 });
            }
            activateAssistant();
            return assistantWidget.content;
        };
        app.commands.addCommand(COMMAND_ID, {
            label: 'Open Jupyter Assistant',
            caption: 'Open the notebook-aware Codex and ChatGPT assistant',
            icon: assistantIcon,
            execute: openAssistant
        });
        palette.addItem({ command: COMMAND_ID, category: 'Notebook' });
        const addToolbarButton = (panel) => {
            const itemName = 'jupyter-notebook-assistant';
            if (Array.from(panel.toolbar.names()).includes(itemName)) {
                return;
            }
            const toolbarButton = new ToolbarButton({
                icon: assistantIcon,
                label: '',
                tooltip: 'Open Jupyter Assistant',
                onClick: openAssistant
            });
            // Some JupyterLab installations have shorter or customized notebook
            // toolbars. Clamp the preferred position and fall back to appending so
            // the button is never silently omitted.
            const preferredIndex = Math.min(10, panel.toolbar.node.children.length);
            if (!panel.toolbar.insertItem(preferredIndex, itemName, toolbarButton)) {
                panel.toolbar.addItem(itemName, toolbarButton);
            }
        };
        notebooks.widgetAdded.connect((_sender, panel) => {
            addToolbarButton(panel);
        });
        // Restored notebook tabs may already exist before this extension activates,
        // so widgetAdded alone is insufficient. Add the button to all notebooks
        // after workspace restoration as well as to notebooks already tracked now.
        notebooks.forEach(addToolbarButton);
        void app.restored.then(() => {
            notebooks.forEach(addToolbarButton);
        });
        document.addEventListener('keydown', event => {
            if (event.repeat) {
                return;
            }
            try {
                const selectAboveShortcut = getSelectAboveShortcut();
                if (selectAboveShortcut &&
                    matchesShortcut(event, selectAboveShortcut)) {
                    const notebook = notebooks.currentWidget?.content;
                    if (!notebook || notebook.activeCellIndex < 0) {
                        return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const activeIndex = notebook.activeCellIndex;
                    notebook.deselectAll();
                    for (let index = 0; index < activeIndex; index += 1) {
                        notebook.select(notebook.widgets[index]);
                    }
                    return;
                }
            }
            catch {
                // Ignore an invalid configured selection shortcut.
            }
            let shortcut = '';
            try {
                shortcut = getConfiguredShortcut();
                if (!shortcut || !matchesShortcut(event, shortcut)) {
                    return;
                }
            }
            catch {
                return;
            }
            const activeCell = notebooks.currentWidget?.content.activeCell;
            if (!activeCell || activeCell.model.type !== 'code') {
                return;
            }
            const directive = extractAssistantDirective(activeCell.model.sharedModel.getSource());
            if (!directive) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const content = openAssistant();
            void content.consumeAssistantDirective();
        }, true);
    }
};
export default plugin;
//# sourceMappingURL=index.js.map