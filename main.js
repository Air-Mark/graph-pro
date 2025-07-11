const {Plugin, Setting, Notice, Menu, setTooltip, setIcon, TFile} = require('obsidian');

// Helper for safely patching methods
const around = (obj, methods) => {
    const unpatchers = Object.keys(methods).map(key => {
        const original = obj[key];
        if (typeof original !== 'function') return;

        obj[key] = methods[key](original);

        return () => { obj[key] = original; };
    }).filter(Boolean);

    return () => unpatchers.forEach(unpatch => unpatch());
};


const DEFAULT_SETTINGS = {
    showIcons: true,
    showNeighborLabels: true,
    showGrid: false,
    snapToGrid: false,
    currentPositionsHistoryKey: null,
    automaticallyRestoreNodePositions: false,
    labelRegex: '',
    frontmatterField: '',
    selectionWidth: 100,
    maxArrangeCircleRadius: 200,
    searchSelectionMode: false,
};

const GPT_BASE_PROMPT = `
You will receive a JSON object describing nodes in a graph.

Each key is a node ID (e.g., "nodes/service-A.md").
Each value contains:
\t•\tx, y: coordinates of the node on a 2D canvas.
\t•\tcolor: it is the group color the node belongs to.
\t•\tlinks: relationships with other nodes (forward and reverse).
\t•\tmetadata: additional meta info.

Your task:
\t1.\tAnalyze the positions and link structure of all nodes.
\t2.\tRearrange the nodes to improve clarity of the layout.
\t3.\tTry to group related nodes closer together, but avoid placing more than two connected nodes in a straight line, as this causes overlapping or confusing link lines.

Constraints:
\t•\tPreserve relative groupings.
\t•\tPrioritize minimal edge crossings against node proximity.
\t•\tKeep the new positions within the current bounding box of all nodes. You may extend the box by up to ±500 units if necessary.
\t•\tDo not remove or modify any fields other than the x and y values.
\t•\tYour response must be a JSON object in the same structure, with only updated x and y values for each node.
\t•\tDo not include any explanation — just return the modified JSON.
\t•\tReturn only x and y fields.

I want you do it manually with your brain and sense of visual beauty.


`

module.exports = class GraphPlugin extends Plugin {
    constructor(app, manifest) {
        super(app, manifest);
        this.settings = structuredClone(DEFAULT_SETTINGS);
        this.iconMap = {
            "services/foo.md": "showIcons/foo.png",
        };
        this.imgCache = new Map();
        // Use a Map to actively manage GraphLeaf lifecycles
        this.graphLeaves = new Map();
        this.currentPositionsHistory = {};
        this.prototypesPatched = false;
        this.registerEvents()
    }

    async onload() {
        await this.loadSettings();
        this.preloadIcons();
    }

    onunload() {
        // Clean up all GraphLeaf controllers on unload
        this.graphLeaves.forEach(leafController => {
            if (leafController.destroy) leafController.destroy();
        });
        this.graphLeaves.clear();
    }

    registerEvents() {
        this.registerEvent(
            this.app.workspace.on('layout-change', () => this.setupGraphLeafOnAllOpenedGraphs())
        );
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (leaf?.view.getViewType() === 'graph') {
                    // It's safer to just re-scan all graphs on any change
                    this.setupGraphLeafOnAllOpenedGraphs();
                }
            })
        );

        this.app.workspace.onLayoutReady(() => {
            this.setupGraphLeafOnAllOpenedGraphs();
        });
    }

    // This method now also handles cleanup of controllers for closed graph views
    setupGraphLeafOnAllOpenedGraphs() {
        const activeRenderers = new Set();
        this.app.workspace.getLeavesOfType('graph').forEach(leaf => {
            if (leaf.view?.renderer) {
                activeRenderers.add(leaf.view.renderer);
            }
        });

        // Destroy controllers for closed leaves
        for (const [renderer, graphLeaf] of this.graphLeaves.entries()) {
            if (!activeRenderers.has(renderer)) {
                if (graphLeaf.destroy) {
                    graphLeaf.destroy();
                }
                this.graphLeaves.delete(renderer);
            }
        }

        // Setup new leaves
        this.app.workspace.getLeavesOfType('graph').forEach(leaf => {
            this.setupGraphOnLeaf(leaf);
        });
    }

    setupGraphOnLeaf(leaf) {
        if (leaf.view.getViewType() !== 'graph') return;
        const renderer = leaf.view?.renderer;
        if (!renderer) return;

        if (this.graphLeaves.has(renderer)) {
            return;
        }

        const graphLeaf = new GraphLeaf(this, leaf);
        this.graphLeaves.set(renderer, graphLeaf);
        graphLeaf.applyAllPatches();
    }

    patchPrototypes(AG) {
        if (this.prototypesPatched) return;
        this.prototypesPatched = true;

        const pluginInstance = this;

        const unpatch = around(AG.prototype, {
            initGraphics: (originalInit) => function() {
                originalInit.apply(this, arguments);

                if (!this._iconSprite) {
                    const img = pluginInstance.imgCache.get(this.id);
                    if (img && img.complete && this.renderer?.hanger) {
                        const sprite = this._iconSprite = PIXI.Sprite.from(img);
                        sprite.eventMode = 'none';
                        sprite.texture.orig.width = 250;
                        sprite.texture.orig.height = 250;
                        sprite.anchor.set(0.1);
                        sprite.visible = pluginInstance.settings.showIcons;
                        this.circle.addChild(sprite);
                    }
                }
                if (this._iconSprite) {
                    this._iconSprite.visible = pluginInstance.settings.showIcons;
                }
            }
        });

        // Register the unpatcher to be called when the plugin is unloaded
        this.register(unpatch);
    }

    async savePositionHistory(positionHistory) {
        const folderPath = `${this.manifest.dir}/position-history`;
        if (!(await this.app.vault.exists(folderPath))) {
            await this.app.vault.createFolder(folderPath);
        }

        const entries = Object.entries(positionHistory);
        for (const [key, value] of entries) {
            let title = key;

            const data = Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map(_key => [_key, {x: value[_key].x, y: value[_key].y}])
            );

            try {
                title = new Date(key).toISOString();
            } catch (e) {
                title = title.replace(/[\/\\:*?"<>|, ]/g, '_');
            }

            const fileName = `${title || 'null'}.json`;
            await this.app.vault.writeJson(`${folderPath}/${fileName}`, data);
        }
    }

    async loadPositionHistory(key) {
        let positionHistory = {};

        try {
            const folderPath = `${this.manifest.dir}/position-history`;
            if (!(await this.app.vault.exists(folderPath))) {
                await this.app.vault.createFolder(folderPath);
            }

            const files = await this.app.vault.adapter.list(folderPath);
            for (const fullPath of files.files) {
                if (!fullPath.endsWith('.json')) continue;

                const fileName = fullPath.split('/').pop();
                const _key = fileName.replace('.json', '');
                if (key === _key) {
                    positionHistory[_key] = await this.app.vault.readJson(fullPath);
                } else {
                    positionHistory[_key] = {};
                }
            }
        } catch (e) {
            // console.debug('Failed to load position history', e);
        }
        return positionHistory;
    }

    async loadSettings() {
        let data = {};
        try {
            data = await this.loadData()
        } catch (e) {

        }
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            data
        );
        const key = this.settings.currentPositionsHistoryKey;
        this.currentPositionsHistory = (await this.loadPositionHistory(key))[key] || {};
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    preloadIcons() {
        if (!this.settings.showIcons) return;

        const vault = this.app.vault;
        Object.entries(this.iconMap).forEach(([noteId, relPath]) => {
            const file = this.app.vault.getAbstractFileByPath(relPath);
            if (file instanceof TFile) {
                const fullPath = this.app.vault.getResourcePath(file);
                const img = new Image();
                img.src = fullPath;
                this.imgCache.set(noteId, img);
            }
        });
    }

    async addPositionsHistory(positions) {
        const ts = (new Date()).toISOString();

        if (!positions) {
            new Notice("Could not save positions. No nodes or renderer found.");
            return;
        }

        const key = this.settings.currentPositionsHistoryKey;
        const currentHistory = (await this.loadPositionHistory(key))[key]
        if (currentHistory && Object.keys(currentHistory).length) {
            for (const id in currentHistory) {
                if (!positions[id]) {
                    positions[id] = currentHistory[id];
                }
            }
        }

        await this.savePositionHistory({[ts]: positions});
        return ts;
    }

    getCurrentPositionsHistory() {
        return this.currentPositionsHistory;
    }
};

class GraphUI {
    constructor(plugin, graphLeaf) {
        this.plugin = plugin;
        this.graphLeaf = graphLeaf;
        this.leaf = this.graphLeaf.leaf;
        this.view = this.leaf.view;
        this.dataEngine = this.view.dataEngine;
        this.renderer = this.view.renderer;

        this.statusContainer = this.plugin.addStatusBarItem()
        this.plugin.app.statusBar.containerEl.prepend(this.statusContainer);

        const {leftGraphControls, topGraphControls} = this._createGraphControlContainers();
        this.leftGraphControls = leftGraphControls;
        this.topGraphControls = topGraphControls;

        this._patchGraphSearchView();
        this._populateTopGraphControls(this.topGraphControls);
        this._populateMainGraphControls(this.leftGraphControls);
    }

    _patchGraphSearchView() {
        const search = this.view.dataEngine.filterOptions.search;
        search.containerEl.classList.add('global-search-input-container');
        search.containerEl.classList.add('graph-pro-global-search-input-container');

        const searchSetting = this.view.dataEngine.filterOptions.searchSetting;

        this.view.titleEl.remove();

        const selectNodesSwitch = this.addGraphControlsAction(this.view.titleContainerEl, 'whole-word', 'Switch search to nodes selection mode', () => {
            filterNodesSwitch.show();
            selectNodesSwitch.hide();
            selectNodesByRegexEl.show();
            searchSetting.controlEl.hide();
            selectNodesByRegexInputEl.focus();
            this.plugin.settings.searchSelectionMode = true;
            this.plugin.saveSettings().then();
        });

        const filterNodesSwitch = this.addGraphControlsAction(this.view.titleContainerEl, 'filter', 'Switch search to filter mode', () => {
            filterNodesSwitch.hide();
            selectNodesSwitch.show();
            selectNodesByRegexEl.hide();
            searchSetting.controlEl.show();
            searchSetting.controlEl.querySelector('input').focus();
            this.plugin.settings.searchSelectionMode = false;
            this.plugin.saveSettings().then();
        });

        this.view.titleContainerEl.append(searchSetting.controlEl);
        this.view.titleContainerEl.classList.remove('mod-fade');
        this.view.titleContainerEl.classList.add('graph-pro-title-container');

        const selectNodesByRegexEl = searchSetting.controlEl.cloneNode(true);
        const selectNodesByRegexInputEl = selectNodesByRegexEl.querySelector('input');
        selectNodesByRegexInputEl.value = '';
        selectNodesByRegexInputEl.addEventListener("keyup", (event) => {
            if (event.key === "Enter") {
                this.graphLeaf.selectNodesByRegex(event.target.value);
            }
        });
        this.view.titleContainerEl.append(selectNodesByRegexEl);
        if (this.plugin?.settings?.searchSelectionMode) {
            selectNodesSwitch.hide();
            searchSetting.controlEl.hide();
        } else {
            filterNodesSwitch.hide();
            selectNodesByRegexEl.hide();
        }
    }

    _createGraphControlContainers() {
        const leftGraphControls = this.view.contentEl.createDiv("graph-controls is-close graph-pro-left-graph-controls");
        const topGraphControls = this.view.contentEl.createDiv("graph-controls is-close graph-pro-top-graph-controls");

        return {leftGraphControls, topGraphControls};
    }

    _setupRestoreButtonContextMenu(restoreButton) {
        restoreButton.addEventListener("contextmenu", async (e) => {
            e.preventDefault();
            const menu = new Menu();

            menu.addItem((item) =>
                item
                    .setTitle('Undo         Ctrl/Cmd+Z')
                    .onClick(() => {
                        this.graphLeaf.undo();
                    })
            );

            menu.addItem((item) =>
                item
                    .setTitle('Redo         Ctrl/Cmd+Shift+Z')
                    .onClick(() => {
                        this.graphLeaf.redo();
                    })
            );

            menu.addSeparator();

            menu.addItem((item) =>
                item
                    .setTitle('Auto restore on startup')
                    .setChecked(this.plugin.settings.automaticallyRestoreNodePositions)
                    .onClick(() => {
                        this.plugin.settings.automaticallyRestoreNodePositions = !this.plugin.settings.automaticallyRestoreNodePositions;
                        this.plugin.saveSettings().then(); // Assuming saveSettings is async
                    })
            );

            menu.addSeparator();

            const sortedHistoryKeys = Object.keys(await this.plugin.loadPositionHistory() || {}).sort().reverse();
            for (const menuKey of sortedHistoryKeys) {
                if (menuKey && menuKey !== 'null') {
                    let title = menuKey;
                    try {
                        const date = new Date(menuKey);
                        if (date.toISOString()) {
                            title = date.toLocaleString(undefined, {
                                year: 'numeric',
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: false
                            });
                        }
                    } catch (e) {
                        // console.log(e)
                    }
                    menu.addItem((item) =>
                        item
                            .setTitle(title)
                            .setChecked(menuKey === this.plugin.settings.currentPositionsHistoryKey)
                            .onClick(async () => {
                                const positions = (await this.plugin.loadPositionHistory(menuKey))[menuKey];
                                if (positions && Object.keys(positions).length) {
                                    this.graphLeaf.restoreNodePositions(positions);
                                    this.plugin.settings.currentPositionsHistoryKey = menuKey;
                                    await this.plugin.saveSettings();
                                    new Notice("Positions restored");
                                } else {
                                    new Notice("No positions found for this timestamp.");
                                }
                            })
                    );
                }
            }
            menu.showAtMouseEvent(e);
        });
    }

    addGraphControlsAction(parent, iconName, tooltipText, clickHandler) {
        const buttonElement = createEl("button", "clickable-icon");
        parent.append(buttonElement);
        setIcon(buttonElement, iconName)
        setTooltip(buttonElement, tooltipText);
        if (clickHandler) {
            buttonElement.onClickEvent(function (event) {
                if (event.button === 0 || event.button === 1) {
                    return clickHandler(event, buttonElement);
                }
            });
        }
        return buttonElement;
    }

    addGraphControlsSwitch(parent, iconName, tooltipText, settingName, clickHandler) {
        const action = this.addGraphControlsAction(parent, iconName, tooltipText)
        const ACTIVE_CLASS = 'has-active-menu';
        const plugin = this.plugin;
        if (Boolean(plugin.settings[settingName])) {
            action.classList.add(ACTIVE_CLASS);
        }
        action.onClickEvent(function (event) {
            if (event.button === 0 || event.button === 1) {
                if (!action.classList.contains(ACTIVE_CLASS)) {
                    action.classList.add(ACTIVE_CLASS);
                } else {
                    action.classList.remove(ACTIVE_CLASS);
                }
                const newValue = action.classList.contains(ACTIVE_CLASS);
                plugin.settings[settingName] = newValue;
                plugin.saveSettings();
                return clickHandler(event, newValue);
            }
        });
    }

    mirrorGraphControlsSwitch(parent, iconName, tooltipText, controlsName, optionName) {
        const self = this;
        const corePlugin = this.plugin.app.internalPlugins.getPluginById("graph").instance;
        const action = this.addGraphControlsAction(parent, iconName, tooltipText)

        const ACTIVE_CLASS = 'has-active-menu';

        if (Boolean(corePlugin.options[optionName])) {
            action.classList.add(ACTIVE_CLASS);
        }

        const originalMethod = this.dataEngine[controlsName].optionListeners[optionName];
        this.dataEngine[controlsName].optionListeners[optionName] = new Proxy(originalMethod, {
            apply: function (targetFn, thisArg, argumentsList) {
                const value = Reflect.apply(targetFn, thisArg, argumentsList);
                if (value) {
                    action.classList.add(ACTIVE_CLASS);
                } else {
                    action.classList.remove(ACTIVE_CLASS);
                }
                return value;
            }
        });

        action.onClickEvent(function (event) {
            corePlugin.options[optionName] = !corePlugin.options[optionName];
            self.dataEngine.setOptions(corePlugin.options);
        });

        return action;
    }

    addGraphControlsInput(parent, iconName, tooltipText, max = null, type = 'number', width = 'normal', settingName) {
        let container = createEl("div");
        setTooltip(container, tooltipText)
        if (iconName) {
            setIcon(container, iconName)
            const icon = container.firstElementChild;
            icon.classList.add('graph-pro-input-icon');
        }

        let element = createEl("input", {"type": type});
        container.append(element);
        element.classList.add('graph-pro-toolbar-input');
        element.classList.add(`graph-pro-toolbar-input-${width}`);
        if (iconName) {
            element.classList.add('graph-pro-toolbar-input-with-icon');
        }
        element.step = '0.1'
        if (max) {
            element.max = max;
        }
        parent.append(container);

        if (settingName) {
            const plugin = this.plugin;
            element.value = plugin.settings[settingName];
            element.oninput = async function (e) {
                let value = Number(element.value) || 0;
                if (element.value !== '' && !e?.data?.endsWith('.')) {
                    plugin.settings[settingName] = value
                    await plugin.saveSettings();
                }
            };
        }

        return element
    }

    mirrorGraphControlsInput(parent, iconName, tooltipText, controlsName, optionName, max) {
        const self = this;
        const plugin = this.plugin.app.internalPlugins.getPluginById("graph").instance;
        const element = this.addGraphControlsInput(parent, iconName, tooltipText, max)
        element.value = plugin.options[optionName];

        let debounceTimer;
        let isExternalUpdate = false;

        function updateElementValueDebounced(val) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                isExternalUpdate = true;
                element.value = val;
                isExternalUpdate = false;
            }, 300);
        }

        const originalMethod = this.dataEngine[controlsName].optionListeners[optionName];
        this.dataEngine[controlsName].optionListeners[optionName] = new Proxy(originalMethod, {
            apply: function (targetFn, thisArg, argumentsList) {
                const value = Reflect.apply(targetFn, thisArg, argumentsList);
                if (Number(element.value) !== value) {
                    updateElementValueDebounced(value);
                }
                return value;
            }
        });

        element.oninput = function (e) {
            if (isExternalUpdate) return;

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                let value = Number(element.value) || 0;
                if (element.value !== '' && !e?.data?.endsWith('.')) {
                    if (max && value > max) {
                        value = max;
                    }
                    self.plugin.settings.automaticallyRestoreNodePositions = false;
                    plugin.options[optionName] = value;
                    self.dataEngine.setOptions(plugin.options);
                    setTimeout(() => {
                        self.plugin.settings.automaticallyRestoreNodePositions = true;
                    }, 500);
                }
            }, 300);
        };

        return element;
    }

    _populateTopGraphControls(controlsContainer) {
        this.addGraphControlsAction(controlsContainer, 'play', 'Run simulation', () => {
            this.graphLeaf.runGraphSimulation();
        });
        this.addGraphControlsAction(controlsContainer, 'square', 'Stop simulation', () => {
            this.graphLeaf.stopGraphSimulation();
        });

        this.mirrorGraphControlsInput(controlsContainer, 'type', 'Text fade threshold', "displayOptions", "textFadeMultiplier");
        this.mirrorGraphControlsInput(controlsContainer, 'locate', 'Node size', "displayOptions", "nodeSizeMultiplier");
        this.mirrorGraphControlsInput(controlsContainer, 'slash', 'Link size', "displayOptions", "lineSizeMultiplier");

        this.addGraphControlsAction(controlsContainer, 'pin-off', 'Unlock selected nodes position', () => {
            this.graphLeaf.unlockSelectedPositions();
        });
        this.mirrorGraphControlsInput(controlsContainer, 'circle-dot', 'Center force', "forceOptions", "centerStrength", 1);
        this.mirrorGraphControlsInput(controlsContainer, 'unfold-horizontal', 'Repel force', "forceOptions", "repelStrength");
        this.mirrorGraphControlsInput(controlsContainer, 'minimize-2', 'Link force', "forceOptions", "linkStrength", 1);
        this.mirrorGraphControlsInput(controlsContainer, 'ruler', 'Link distance', "forceOptions", "linkDistance");

        this.addGraphControlsAction(controlsContainer, 'magnet', 'Set selected nodes weight', () => {
            this.graphLeaf.setSelectionWeight(Number(weight.value));
        });
        const weight = this.addGraphControlsInput(controlsContainer, null, 'Weight', null, 'number', 'narrow');

        this.addGraphControlsAction(controlsContainer, 'move', 'Move selected nodes', () => {
            this.graphLeaf.moveSelection(Number(moveVertical.value) || 0, Number(moveHorizontal.value) || 0);
        });
        const moveVertical = this.addGraphControlsInput(controlsContainer, 'move-vertical', 'Move vertical');
        const moveHorizontal = this.addGraphControlsInput(controlsContainer, 'move-horizontal', 'Move horizontal');

        this.addGraphControlsAction(controlsContainer, 'scaling', 'Move selected nodes', () => {
            this.graphLeaf.scaleSelection(Number(scaleRatio.value) || 0.1);
        });
        const scaleRatio = this.addGraphControlsInput(controlsContainer, null, 'Scale ratio', null, 'number', 'narrow');

        this.addGraphControlsAction(controlsContainer, 'circle-dot-dashed', 'Arrange selected in circle', () => {
            this.graphLeaf.arrangeSelectedObjectsInCircle(Number(maxArrangeCircleRadius.value) || null);
        });
        const maxArrangeCircleRadius = this.addGraphControlsInput(controlsContainer, null, 'Max arrange circle radius', null, 'number', 'narrow', "maxArrangeCircleRadius");

        this.addGraphControlsAction(controlsContainer, 'workflow', 'Select related', () => {
            this.graphLeaf.selectRelated(Number(selectRelatedDepth.value) || 1);
        });
        const selectRelatedDepth = this.addGraphControlsInput(controlsContainer, null, 'Select related depth', null, 'number', 'narrow');
        this.addGraphControlsAction(controlsContainer, 'links-coming-in', 'Select backlinks', () => {
            this.graphLeaf.selectBacklinks();
        });
        this.addGraphControlsAction(controlsContainer, 'links-going-out', 'Select outgoing links', () => {
            this.graphLeaf.selectOutgoingLinks();
        });

        const selectNodesWithPositionType = this.addGraphControlsAction(controlsContainer, 'atom', 'Select nodes with position is\nLeft-click: unlocked\nRight-click: locked', () => {
            this.graphLeaf.selectNodesWithPositionType(false);
        });
        selectNodesWithPositionType.addEventListener("contextmenu", async (e) => {
            e.preventDefault();
            this.graphLeaf.selectNodesWithPositionType(true);
        });

        this.addGraphControlsInput(controlsContainer, 'paint-roller', 'Selection width', 500, 'number', 'wide', "selectionWidth");
    }

    _populateMainGraphControls(controlsContainer) {
        this.addGraphControlsAction(controlsContainer, 'save', 'Save', async () => {
            const key = await this.plugin.addPositionsHistory(this.graphLeaf.getNodesPosition());
            if (key) {
                this.plugin.settings.currentPositionsHistoryKey = key;
                await this.plugin.saveSettings();
                new Notice("Positions saved");
            }
        });

        const restoreButton = this.addGraphControlsAction(controlsContainer, 'history', 'Restore\nRight-click: history', () => {
            const positions = this.plugin.getCurrentPositionsHistory();
            if (positions && Object.keys(positions).length) {
                this.graphLeaf.restoreNodePositions(positions);
                new Notice("Positions restored");
            } else {
                new Notice("No positions found for this timestamp.");
            }
        });
        this._setupRestoreButtonContextMenu(restoreButton);

        this.addGraphControlsAction(controlsContainer, 'align-start-horizontal', 'Align start horizontal', () => {
            this.graphLeaf.alignSelected('y', 'min');
        });
        this.addGraphControlsAction(controlsContainer, 'align-start-vertical', 'Align start vertical', () => {
            this.graphLeaf.alignSelected('x', 'min');
        });
        this.addGraphControlsAction(controlsContainer, 'align-end-vertical', 'Align end vertical', () => {
            this.graphLeaf.alignSelected('x', 'max');
        });
        this.addGraphControlsAction(controlsContainer, 'align-end-horizontal', 'Align end horizontal', () => {
            this.graphLeaf.alignSelected('y', 'max');
        });

        this.addGraphControlsSwitch(controlsContainer, 'type-outline', 'Display neighbor label', "showNeighborLabels", (e, isActive) => {
            if (!isActive) this.graphLeaf.clearNeighborLabels();
            else if (this.renderer.hoveredNode) this.graphLeaf.renderNeighborLabels(renderer.hoveredNode.id);
        });
        this.addGraphControlsSwitch(controlsContainer, 'image', 'Display node image', "showIcons", (e, isActive) => {
            this.plugin.settings.showIcons = isActive;
            (this.renderer.nodes || []).forEach(n => {
                if (n._iconSprite) n._iconSprite.visible = isActive;
            });
        });

        this.mirrorGraphControlsSwitch(controlsContainer, 'navigation', 'Display arrows', 'displayOptions', 'showArrow');
        this.mirrorGraphControlsSwitch(controlsContainer, 'tags', 'Tags', 'filterOptions', 'showTags');
        this.mirrorGraphControlsSwitch(controlsContainer, 'paperclip', 'Attachments', 'filterOptions', 'showAttachments');
        this.mirrorGraphControlsSwitch(controlsContainer, 'ghost', 'Existing files only', 'filterOptions', 'hideUnresolved');
        this.mirrorGraphControlsSwitch(controlsContainer, 'circle', 'Orphans', 'filterOptions', 'showOrphans');

        this.addGraphControlsSwitch(controlsContainer, 'grid', 'Show grid', 'showGrid', (e, isActive) => {
            this.graphLeaf.showGrid(isActive);
        });
        this.addGraphControlsSwitch(controlsContainer, 'flip-horizontal-2', 'Snap to grid', 'snapToGrid', (e, isActive) => {
            // Logic for snapToGrid if any direct action is needed on switch
        });

        this.addGraphControlsAction(controlsContainer, 'brain-circuit', 'Copy GPT prompt to clipboard', (e) => {
            this.graphLeaf.copyGPTPromptToClipboard();
        });

        this.addGraphControlsAction(controlsContainer, 'clipboard-paste', 'Update nodes position from clipboard', async (e) => {
            await this.graphLeaf.updateNodesPositionFromClipboard();
        });
    }
}

class GraphLeaf {
    constructor(plugin, leaf) {
        this.plugin = plugin;
        this.leaf = leaf;
        this.view = this.leaf.view;
        this.dataEngine = this.leaf.view.dataEngine;
        this.renderer = this.leaf.view.renderer;
        this.px = this.renderer.px;
        this.app = this.plugin.app;

        this.isApplied = false;
        this._hoveredNeighborLabels = new Set();
        this.selectedNodes = []
        this._inmemoryHistoryIndex = 0;
        this._inmemoryHistory = [];
        this._inmemoryHistory[0] = this.plugin.getCurrentPositionsHistory();

        // To store unpatch functions for instance-specific patches
        this.unpatchers = [];

        this.ui = new GraphUI(plugin, this);
    }

    // This method will be called by the plugin to clean up patches
    destroy() {
        this.unpatchers.forEach(unpatch => unpatch());
        this.unpatchers = [];
    }

    getNodesPosition() {
        const positions = new Map();
        this.renderer.nodes.forEach((node) => {
            positions[node.id] = {
                id: node.id,
                x: node.x,
                y: node.y,
                fx: node.fx,
                fy: node.fy,
            }
        });
        return positions
    }

    addInmemoryHistory() {
        self = this;
        setTimeout(() => {
            self._inmemoryHistory.splice(this._inmemoryHistoryIndex + 1);
            self._inmemoryHistory.push(self.getNodesPosition());
            self._inmemoryHistoryIndex = this._inmemoryHistory.length - 1;
            if (self._inmemoryHistory.length > 100) {
                self._inmemoryHistory.splice(100);
            }
        }, 300);
    }

    undo() {
        const index = this._inmemoryHistoryIndex ? this._inmemoryHistoryIndex - 1 : 0;
        if (index >= 0) {
            this.restoreNodePositions(this._inmemoryHistory[index]);
            this._inmemoryHistoryIndex = index;
        }
    }

    redo() {
        const index = this._inmemoryHistoryIndex + 1;
        if (index < this._inmemoryHistory.length) {
            this.restoreNodePositions(this._inmemoryHistory[index]);
            this._inmemoryHistoryIndex = index;
        }
    }

    applyAllPatches() {
        if (this.isApplied) return;
        this.isApplied = true;

        this.setupGrid();
        this.patchRenderer();
        this.patchPixi();
        this.patchWorker();
        this.addGraphControls();
        this.extendMaxSizeInput();
        this.patchIconGraphics();
        this.setupHoverLabels();
    }

    patchRenderer() {
        const self = this;
        const renderer = this.renderer;

        const unpatch = around(renderer, {
            setData: (originalSetData) => function(...args) {
                const res = originalSetData.apply(this, args);
                if (self.plugin.settings.automaticallyRestoreNodePositions) {
                    let positions;
                    if (self._inmemoryHistory.length) {
                        positions = self._inmemoryHistory[self._inmemoryHistoryIndex];
                    }
                    self.restoreNodePositions(positions);
                }
                return res;
            }
        });
        this.unpatchers.push(unpatch);
    }

    patchPixi() {
        const self = this;
        const [stageBg, nodesLinksContainer] = this.px.stage.children;
        let isDrawing = false;
        let startPoint = {x: 0, y: 0};

        // Transparent overlay to capture pointer events
        const overlay = new PIXI.Graphics();
        overlay.eventMode = 'static';
        overlay.beginFill(0x000000);
        overlay.drawRect(0, 0, 10000, 10000);
        overlay.endFill();
        overlay.alpha = 0;
        overlay.visible = false;
        this.px.stage.addChild(overlay);

        // Layer for drawing the selection rectangle
        const selectionLayer = new PIXI.Container();
        this.px.stage.addChild(selectionLayer);

        // Selection rectangle graphics
        const selectionRect = new PIXI.Graphics();
        selectionRect.visible = false;
        selectionLayer.addChild(selectionRect);

        // Helper to clear and hide the selection rectangle
        const cancelSelection = () => {
            selectionRect.clear();
            if (selectionRect?.visible) {
                selectionRect.visible = false;
                this.renderer?.px?.render();
            }
        };

        // Key event handlers
        const onKeyDown = (e) => {
            if (e.shiftKey) {
                isDrawing = false;
                stageBg.visible = false;
                overlay.visible = true;
                nodesLinksContainer.eventMode = 'none';
            }
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
                if (e.shiftKey) {
                    self.redo();
                } else {
                    self.undo();
                }
            }

            this.altPressed = e.altKey;
        };

        const onKeyUp = (e) => {
            if (!e.shiftKey) {
                isDrawing = false;
                overlay.visible = false;
                stageBg.visible = true;
                cancelSelection();
                nodesLinksContainer.eventMode = 'static';
            }
            this.altPressed = e.altKey;
        };

        document.body.addEventListener('keydown', onKeyDown);
        document.body.addEventListener('keyup', onKeyUp);

        // Unregister listeners when leaf is destroyed
        this.unpatchers.push(() => {
            document.body.removeEventListener('keydown', onKeyDown);
            document.body.removeEventListener('keyup', onKeyUp);
        });

        // Pointer events for selection
        overlay.on('pointerdown', (e) => {
            // Only start drawing if Shift is held
            if (!this.renderer?.keyboardActions?.shift) {
                cancelSelection();
                return;
            }
            isDrawing = true;
            const pos = e.data.getLocalPosition(overlay);
            startPoint = {x: pos.x, y: pos.y};
            selectionRect.clear();
            selectionRect.visible = true;
            this.renderer.px.render();
        });

        overlay.on('globalmousemove', (e) => {
            if (!isDrawing) {
                cancelSelection();
                return;
            }
            const pos = e.data.getLocalPosition(overlay);
            const x = Math.min(startPoint.x, pos.x);
            const y = Math.min(startPoint.y, pos.y);
            const w = Math.abs(pos.x - startPoint.x);
            const h = Math.abs(pos.y - startPoint.y);

            selectionRect.clear();
            selectionRect.beginFill(0x9872f5, 0.1);
            selectionRect.lineStyle(2, 0x9872f5, 0.3);
            selectionRect.drawRect(x, y, w, h);
            selectionRect.endFill();
            this.renderer.px.render();
        });

        overlay.on('pointerup', (e) => {
            isDrawing = false;

            // Determine selection bounds
            const endPos = e.data.getLocalPosition(overlay);
            const xMin = Math.min(startPoint.x, endPos.x);
            const yMin = Math.min(startPoint.y, endPos.y);
            const xMax = Math.max(startPoint.x, endPos.x);
            const yMax = Math.max(startPoint.y, endPos.y);

            // Identify nodes within selection
            const selectedNodes = this.renderer.nodes.filter(node => {
                const _node = nodesLinksContainer.localTransform.apply({x: node.x, y: node.y})
                return _node.x >= xMin && _node.x <= xMax && _node.y >= yMin && _node.y <= yMax
            });

            this.onNodesSelected(selectedNodes);

            cancelSelection();
            nodesLinksContainer.eventMode = 'static';
        });
    }

    onNodesSelected(selectedNodes) {
        this.selectedNodes.forEach((node) => {
            if (node._selectionStroke) {
                try {
                    node?._selectionStroke?.destroy();
                    if (node?._selectionStroke) {
                        node._selectionStroke = undefined;
                    }
                } catch (e) {

                }
            }
        })
        const uniqueNodes = new Map();
        if (selectedNodes && selectedNodes.length) {
            this.selectedNodes.forEach(node => uniqueNodes.set(node.id, node))
            if (this.altPressed) {
                selectedNodes.forEach(node => uniqueNodes.delete(node.id));
            } else {
                selectedNodes.forEach(node => uniqueNodes.set(node.id, node));
            }

            uniqueNodes.values().forEach((node) => {
                if (!node?.circle) {
                    return
                }

                const localBounds = node.circle.getLocalBounds();

                const radius = Math.min(localBounds.width, localBounds.height) / 2;
                const centerX = localBounds.x + localBounds.width / 2;
                const centerY = localBounds.y + localBounds.height / 2;

                const strokeCircle1 = new PIXI.Graphics();
                const strokeCircle2 = new PIXI.Graphics();
                const strokeWidth = this.plugin.settings.selectionWidth || 100;

                strokeCircle1.lineStyle(strokeWidth, 0xFEDD00, 1);
                strokeCircle1.drawCircle(centerX, centerY, radius);

                strokeCircle2.lineStyle(strokeWidth / 2, 0x9872f5, 1);
                strokeCircle2.drawCircle(centerX, centerY, radius + strokeWidth / 2);

                strokeCircle1.addChild(strokeCircle2);
                node.circle.addChild(strokeCircle1);
                node._selectionStroke = strokeCircle1;
            })
        }

        this.selectedNodes = [...uniqueNodes.values()];

        this.renderer.px.render();

        this.updateSelectionStatusText()
    }

    updateSelectionStatusText() {
        this.ui.statusContainer.empty();

        if (!this.selectedNodes || this.selectedNodes.length === 0) {
            return;
        }

        const keysToTrack = ['cluster', 'namespace', 'service'];

        const nodesCountSpan = this.ui.statusContainer.createSpan();
        nodesCountSpan.setText(`nodes: ${this.selectedNodes.length}`);
        let addedSeparator = false;

        if (keysToTrack.length === 0) {
            return;
        }

        const frontmatterStats = new Map();
        for (const key of keysToTrack) {
            frontmatterStats.set(key, new Set());
        }

        for (const node of this.selectedNodes) {
            const frontmatter = this.getNodeFrontmatter(node.id);
            if (frontmatter) {
                for (const key of keysToTrack) {
                    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
                        const value = frontmatter[key];
                        const currentKeySet = frontmatterStats.get(key);

                        if (currentKeySet) {
                            if (Array.isArray(value)) {
                                value.forEach(item => {
                                    if (item !== null && item !== undefined) {
                                        currentKeySet.add(String(item));
                                    }
                                });
                            } else if (value !== null && value !== undefined) {
                                currentKeySet.add(String(value));
                            }
                        }
                    }
                }
            }
        }

        const splitter = {text: " | ", attr: {style: "margin-left: 5px; margin-right: 5px;"}};

        for (const key of keysToTrack) {
            const uniqueValuesSet = frontmatterStats.get(key);
            if (uniqueValuesSet && uniqueValuesSet.size > 0) {
                this.ui.statusContainer.createSpan(splitter);

                const keyStatSpan = this.ui.statusContainer.createEl('div');
                keyStatSpan.setText(`${key}: ${uniqueValuesSet.size}`);

                const tooltipContent = Array.from(uniqueValuesSet).sort().join('\n');

                if (tooltipContent) {
                    setTooltip(keyStatSpan, tooltipContent, {placement: "top", delay: 0.01});
                }
                addedSeparator = true;
            }
        }


        if (this.selectedNodes.length === 1) {
            const node = this.selectedNodes[0];

            this.ui.statusContainer.createSpan(splitter);
            const keyBacklinks = this.ui.statusContainer.createEl('div', 'status-bar-item plugin-editor-status mod-clickable');
            keyBacklinks.setText(`backlinks: ${this.getNodeBacklinks(node.id)?.keys()?.length || 0}`);
            keyBacklinks.onClickEvent(event => {
                this.openSideLeafForNode(this.selectedNodes[0].id, "backlink");
            });
            this.ui.statusContainer.createSpan(splitter);
            const keyOutgoingLinks = this.ui.statusContainer.createEl('div', 'status-bar-item plugin-editor-status mod-clickable');
            keyOutgoingLinks.setText(`outgoing links: ${this.getNodeOutgoingLinks(node.id)?.size || 0}`);
            keyOutgoingLinks.onClickEvent(event => {
                this.openSideLeafForNode(this.selectedNodes[0].id, 'outgoing-link');
            });
            this.ui.statusContainer.createSpan(splitter);
            const keyProperties = this.ui.statusContainer.createEl('div', 'status-bar-item plugin-editor-status mod-clickable');
            keyProperties.setText(`properties: ${Object.keys(this.getNodeFrontmatter(node.id) || {}).length || 0}`);
            keyProperties.onClickEvent(event => {
                this.openSideLeafForNode(this.selectedNodes[0].id, 'file-properties');
            });
        }
    }

    async openSideLeafForNode(nodeId, type) {
        if (!nodeId) {
            return;
        }
        let leaf = this.app.workspace.getLeavesOfType(type)[0];
        if (leaf) {
            try {
                const targetFile = this.app.vault.getAbstractFileByPath(nodeId);
                await leaf.setViewState({
                    type: type,
                    state: {
                        file: targetFile.path,
                    },
                    active: true,
                });

                this.app.workspace.revealLeaf(leaf);
            } catch (error) {
            }
        }
    }

    setSelectionWeight(weight) {
        for (const node of this.selectedNodes) {
            node.weight = weight;
        }
        this.renderer.worker.postMessage({
            run: true,
            alpha: 1,
            alphaTarget: 0
        });
    }

    dragCoSelectedNodes(dragNode, dragStartOriginalPosition) {
        if (!dragNode || !dragStartOriginalPosition) {
            return;
        }

        const deltaX = dragNode.x - dragStartOriginalPosition.x;
        const deltaY = dragNode.y - dragStartOriginalPosition.y;
        if (Math.abs(deltaX) < 0.1 && Math.abs(deltaY) < 0.1) {
            return;
        }

        let nodesWereUpdated = false;

        for (const selectedNode of this.selectedNodes) {
            let newX, newY;

            if (selectedNode.id === dragNode.id) {
                newX = dragNode.x;
                newY = dragNode.y;
            } else {
                newX = selectedNode.x + deltaX;
                newY = selectedNode.y + deltaY;
            }

            const forceNode = {
                id: selectedNode.id,
                x: newX,
                y: newY,
                fx: newX,
                fy: newY,
            };
            this.renderer.worker.postMessage({forceNode});
            nodesWereUpdated = true;
        }

        if (nodesWereUpdated) {
            this.renderer.worker.postMessage({
                run: true,
                alpha: 0.3,
                alphaTarget: 0
            });
        }
    }

    scaleSelection(scaleRatio) {
        if (!this.selectedNodes || this.selectedNodes.length === 0) {
            // console.warn("No nodes selected or selection is empty.");
            return;
        }
        if (typeof scaleRatio !== 'number' || isNaN(scaleRatio)) {
            // console.error("scaleRatio must be a valid number.");
            return;
        }
        if (scaleRatio === 0) {
            // While mathematically valid (collapses all points to the centroid),
            // it might be an undesirable state. A warning is good.
            // console.warn("scaleRatio of 0 will collapse all selected nodes to their centroid.");
        }
        if (this.selectedNodes.length === 1 && scaleRatio !== 1) {
            // Scaling a single point around itself doesn't change its position,
            // unless you consider scaling its "size" or other properties not handled here.
            // For x,y coordinates, it remains fixed.
            // console.warn("Scaling a single node around its own position (centroid) will not change its x, y coordinates. No force updates will be sent.");
            // Optionally, you could still trigger the simulation run if other global effects are desired
            // this.renderer.worker.postMessage({ run: true, alpha: 1, alphaTarget: 0 });
            return; // No coordinate changes to send for a single node.
        }


        // 1. Calculate the centroid of the selected nodes.
        // This will be the origin of scaling.
        let sumX = 0;
        let sumY = 0;
        for (const node of this.selectedNodes) {
            sumX += node.x || 0; // Default to 0 if node.x is undefined/null
            sumY += node.y || 0; // Default to 0 if node.y is undefined/null
        }

        // Since we've checked selectedNodes.length > 0, no division by zero here.
        const originX = sumX / this.selectedNodes.length;
        const originY = sumY / this.selectedNodes.length;

        // console.log(`Scaling around centroid: (${originX.toFixed(2)}, ${originY.toFixed(2)}) with ratio: ${scaleRatio}`);

        for (const node of this.selectedNodes) {
            const currentX = node.x || 0;
            const currentY = node.y || 0;

            // 2. Translate node so the origin of scaling (centroid) is at (0,0)
            const translatedX = currentX - originX;
            const translatedY = currentY - originY;

            // 3. Scale uniformly
            const scaledX = translatedX * scaleRatio;
            const scaledY = translatedY * scaleRatio;

            // 4. Translate back to the original coordinate system
            const newX = scaledX + originX;
            const newY = scaledY + originY;

            const forceNode = {
                id: node.id,
                x: newX,
                y: newY,
                fx: newX, // Fix the node to the new scaled position
                fy: newY, // Fix the node to the new scaled position
            };
            this.renderer.worker.postMessage({forceNode});
        }

        this.renderer.worker.postMessage({
            run: true,
            alpha: 1,
            alphaTarget: 0
        });
        this.addInmemoryHistory();
    }

    moveSelection(vertical, horizontal) {
        for (const node of this.selectedNodes) {
            const forceNode = {
                id: node.id,
                x: node.x + horizontal,
                y: node.y + vertical,
                fx: node.x + horizontal,
                fy: node.y + vertical,
            }
            this.renderer.worker.postMessage({forceNode});
        }
        this.renderer.worker.postMessage({
            run: true,
            alpha: 1,
            alphaTarget: 0
        });
        this.addInmemoryHistory();
    }

    selectNodesWithPositionType(isFixed = true) {
        const result = [];
        const inmemoryHistory = this._inmemoryHistory[this._inmemoryHistoryIndex]
        for (const node of this.renderer.nodes) {
            if (node) {
                if (isFixed && node.id in inmemoryHistory) {
                    result.push(node);
                } else if (!isFixed && !(node.id in inmemoryHistory)) {
                    result.push(node);
                }
            }
        }
        this.onNodesSelected(result);
    }

    selectNodesByRegex(regexString) {
        const result = [];
        let compiledRegex;

        try {
            compiledRegex = new RegExp(regexString);
        } catch (error) {
            return;
        }

        if (!this.renderer || !this.renderer.nodes || !Array.isArray(this.renderer.nodes)) {
            // console.warn("this.renderer.nodes is empty");
            return;
        }

        for (const node of this.renderer.nodes) {
            if (node && typeof node.id === 'string') {
                if (compiledRegex.test(node.id)) {
                    result.push(node);
                }
            }
        }

        this.onNodesSelected(result);
    }

    getNodeBacklinks(nodeId) {
        const file = this.app.vault.getAbstractFileByPath(nodeId);
        if (file) {
            return this.app.metadataCache.getBacklinksForFile(file);
        }
        return undefined;
    }

    selectBacklinks() {
        const backlinks = new Set();
        for (const node of this.selectedNodes) {
            const backlinkMap = this.getNodeBacklinks(node.id);
            if (backlinkMap) {
                for (const sourcePath of backlinkMap.keys()) {
                    backlinks.add(sourcePath);
                }
            }
        }

        const combined = new Map();
        for (const node of this.selectedNodes) {
            combined.set(node.id, node);
        }

        for (const path of backlinks) {
            if (!combined.has(path) && this.renderer.nodeLookup[path]) {
                combined.set(path, this.renderer.nodeLookup[path]);
            }
        }

        this.onNodesSelected(Array.from(combined.values()));
    }

    getNodeOutgoingLinks(nodeId) {
        const outgoingLinks = new Set();

        const file = this.app.vault.getAbstractFileByPath(nodeId);
        if (file) {
            const cache = this.app.metadataCache.getFileCache(file);

            if (cache?.links) {
                for (const link of cache.links) {
                    const cleanPath = link.link.split('#')[0];
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(cleanPath, file.path);
                    if (linkedFile) {
                        outgoingLinks.add(linkedFile.path);
                    }
                }
            }

            if (Array.isArray(cache?.frontmatterLinks)) {
                for (const item of cache.frontmatterLinks) {
                    const cleanPath = item.link.split('#')[0];
                    const linkedFile = this.app.metadataCache.getFirstLinkpathDest(cleanPath, file.path);
                    if (linkedFile) {
                        outgoingLinks.add(linkedFile.path);
                    }
                }
            }
        }

        return outgoingLinks;
    }

    selectOutgoingLinks() {
        const outgoingLinks = new Set();

        for (const node of this.selectedNodes) {
            outgoingLinks.add(...this.getNodeOutgoingLinks(node.id))
        }

        const combined = new Map();
        for (const node of this.selectedNodes) {
            combined.set(node.id, node);
        }

        for (const path of outgoingLinks) {
            if (!combined.has(path) && this.renderer.nodeLookup[path]) {
                combined.set(path, this.renderer.nodeLookup[path]);
            }
        }

        this.onNodesSelected(Array.from(combined.values()));
    }

    getNodeFrontmatter(nodeId) {
        const file = this.app.vault.getAbstractFileByPath(nodeId);
        if (file) {
            const cache = this.app.metadataCache.getFileCache(file);
            return cache?.frontmatter;
        }
        return undefined
    }

    selectRelated(depth = 1) {
        if (depth < 0) {
            depth = 0;
        }

        const result = new Map();
        const queue = [];

        for (const initialNode of this.selectedNodes) {
            if (!initialNode) continue;

            if (!result.has(initialNode.id)) {
                result.set(initialNode.id, initialNode);
                queue.push({node: initialNode, currentDepth: 0});
            }
        }

        let head = 0;

        while (head < queue.length) {
            const {node: currentNode, currentDepth} = queue[head++];

            if (currentDepth >= depth) {
                continue;
            }

            const relatedIds = currentNode.getRelated();
            if (!relatedIds || !currentNode.renderer || !currentNode.renderer.nodeLookup) {
                // console.warn(`Node ${currentNode.id} has missing getRelated or renderer.nodeLookup`);
                continue;
            }

            for (const relatedId of relatedIds) {
                if (!result.has(relatedId)) {
                    const relatedNode = currentNode.renderer.nodeLookup[relatedId];
                    if (relatedNode) {
                        result.set(relatedId, relatedNode);
                        queue.push({node: relatedNode, currentDepth: currentDepth + 1});
                    }
                }
            }
        }

        this.onNodesSelected([...result.values()]);
    }

    arrangeSelectedObjectsInCircle(radius) {
        const objects = this.arrangeObjectsInShapes(this.selectedNodes, radius, ['rabbit', 'redis', 'rmq', 'postg']);
        for (const node of objects) {
            const forceNode = {
                id: node.id,
                x: node.x,
                y: node.y,
                fx: node.x,
                fy: node.y,
            }
            this.renderer.worker.postMessage({forceNode});
        }
        this.renderer.worker.postMessage({
            run: true,
            alpha: 1,
            alphaTarget: 0
        });
        this.addInmemoryHistory();
    }

    arrangeObjectsInShapes(
        objects,
        customOuterRadius = null,
        innerCircleIdSubstrings = []
    ) {
        if (!objects || !Array.isArray(objects) || objects.length === 0) {
            return [];
        }
        if (objects.length === 1) {
            return objects;
        }

        if (objects.length === 3) {
            let maxWeightObject = objects[0];
            if (objects[1].weight > maxWeightObject.weight) maxWeightObject = objects[1];
            if (objects[2].weight > maxWeightObject.weight) maxWeightObject = objects[2];

            const others = objects.filter(obj => obj.id !== maxWeightObject.id);
            others.sort((a, b) => String(a.id).localeCompare(String(b.id)));
            const objB = others[0];
            const objC = others[1];

            const cx = maxWeightObject.x;
            const cy = maxWeightObject.y;

            const defaultSideLengthForTriangle = 150;
            const sideLength = (typeof customOuterRadius === 'number' && customOuterRadius > 0)
                ? customOuterRadius
                : defaultSideLengthForTriangle;

            const angleOffset = -Math.PI / 6;
            const angleBetweenSides = Math.PI / 3;

            objB.x = cx + sideLength * Math.cos(angleOffset);
            objB.y = cy + sideLength * Math.sin(angleOffset);

            objC.x = cx + sideLength * Math.cos(angleOffset + angleBetweenSides);
            objC.y = cy + sideLength * Math.sin(angleOffset + angleBetweenSides);

            return objects;
        }

        let centerObject = objects[0];
        for (let i = 1; i < objects.length; i++) {
            if (objects[i].weight > centerObject.weight) {
                centerObject = objects[i];
            }
        }
        const centerX = centerObject.x;
        const centerY = centerObject.y;

        const allPeripheralObjects = objects.filter(obj => obj.id !== centerObject.id);
        const innerCircleObjects = [];
        const outerCircleObjects = [];

        if (innerCircleIdSubstrings && innerCircleIdSubstrings.length > 0 && Array.isArray(innerCircleIdSubstrings)) {
            allPeripheralObjects.forEach(obj => {
                const objectIdStr = String(obj.id);
                if (innerCircleIdSubstrings.some(sub => typeof sub === 'string' && objectIdStr.includes(sub))) {
                    innerCircleObjects.push(obj);
                } else {
                    outerCircleObjects.push(obj);
                }
            });
        } else {
            outerCircleObjects.push(...allPeripheralObjects);
        }

        const numInner = innerCircleObjects.length;
        const numOuter = outerCircleObjects.length;

        if (numInner === 0 && numOuter === 0 && objects.length > 1) {
            return objects;
        }

        let outerRadius = 0;
        let innerRadius = 0;

        const defaultMinOuterRadius = 100;
        const defaultMinInnerRadius = 50;
        const defaultInnerRadiusRatio = 0.6;
        const absoluteMinRadius = 10;
        const radiusGap = Math.max(absoluteMinRadius, 20);

        if (numOuter > 0) {
            if (typeof customOuterRadius === 'number' && customOuterRadius > 0) {
                outerRadius = customOuterRadius;
            } else {
                let totalDistanceSum = 0;
                let pointsForRadiusCalc = 0;
                const refObjectsForOuter = (numInner > 0 && allPeripheralObjects.length > numOuter) ? allPeripheralObjects : outerCircleObjects;
                refObjectsForOuter.forEach(pObj => {
                    const dx = pObj.x - centerX;
                    const dy = pObj.y - centerY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    if (distance > 0.0001) {
                        totalDistanceSum += distance;
                        pointsForRadiusCalc++;
                    }
                });
                outerRadius = (pointsForRadiusCalc > 0) ? (totalDistanceSum / pointsForRadiusCalc) : (defaultMinOuterRadius * Math.max(1, numOuter / 2 + 0.5));
            }
            if (outerRadius < defaultMinOuterRadius && !(typeof customOuterRadius === 'number' && customOuterRadius > 0 && customOuterRadius < defaultMinOuterRadius)) {
                outerRadius = defaultMinOuterRadius;
            }
            if (outerRadius < absoluteMinRadius) outerRadius = absoluteMinRadius;
        }

        if (numInner > 0) {
            if (numOuter > 0) {
                innerRadius = outerRadius * defaultInnerRadiusRatio;
                if (innerRadius < defaultMinInnerRadius) innerRadius = defaultMinInnerRadius;

                if (innerRadius >= outerRadius - radiusGap + 0.001) {
                    innerRadius = outerRadius - radiusGap;
                }
                if (innerRadius < absoluteMinRadius) innerRadius = absoluteMinRadius;

                if (innerRadius < 0) innerRadius = 0;
                if (innerRadius >= outerRadius && outerRadius > absoluteMinRadius) {
                    innerRadius = outerRadius - absoluteMinRadius;
                } else if (innerRadius >= outerRadius) {
                    innerRadius = Math.max(0, outerRadius * 0.5);
                }

            } else {
                if (typeof customOuterRadius === 'number' && customOuterRadius > 0) {
                    innerRadius = customOuterRadius;
                } else {
                    let totalDistanceSum = 0;
                    let pointsForRadiusCalc = 0;
                    innerCircleObjects.forEach(pObj => {
                        const dx = pObj.x - centerX;
                        const dy = pObj.y - centerY;
                        const distance = Math.sqrt(dx * dx + dy * dy);
                        if (distance > 0.0001) {
                            totalDistanceSum += distance;
                            pointsForRadiusCalc++;
                        }
                    });
                    innerRadius = (pointsForRadiusCalc > 0) ? (totalDistanceSum / pointsForRadiusCalc) : (defaultMinInnerRadius * Math.max(1, numInner / 2 + 0.5));
                }
                if (innerRadius < defaultMinInnerRadius && !(typeof customOuterRadius === 'number' && customOuterRadius > 0 && customOuterRadius < defaultMinInnerRadius)) {
                    innerRadius = defaultMinInnerRadius;
                }
                if (innerRadius < absoluteMinRadius) innerRadius = absoluteMinRadius;
            }
        }
        if (innerRadius < 0) innerRadius = 0;


        const distributeOnCircle = (nodes, radius, numNodesOnCircle, baseStartAngle = 0) => {
            if (numNodesOnCircle === 0 || radius <= 0.001) return;

            let angles = [];
            if (numNodesOnCircle === 1) {
                angles.push(baseStartAngle);
            } else if (numNodesOnCircle === 2) {
                angles.push(baseStartAngle);
                angles.push(baseStartAngle + Math.PI);
            } else {
                const angleStep = (2 * Math.PI) / numNodesOnCircle;
                for (let i = 0; i < numNodesOnCircle; i++) {
                    angles.push(baseStartAngle + i * angleStep);
                }
            }

            nodes.forEach((pObj, index) => {
                const currentAngle = angles[index];
                pObj.x = centerX + radius * Math.cos(currentAngle);
                pObj.y = centerY + radius * Math.sin(currentAngle);
            });
        };

        let innerStartAngle = -Math.PI / 2;
        let outerStartAngle = 0;

        if (numInner > 0 && numOuter === 0) {
            innerStartAngle = 0;
        }
        if (numOuter > 0 && numInner === 0) {
            outerStartAngle = 0;
        }

        if (numInner > 0) {
            innerCircleObjects.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        }
        if (numOuter > 0) {
            outerCircleObjects.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        }

        distributeOnCircle(innerCircleObjects, innerRadius, numInner, innerStartAngle);
        distributeOnCircle(outerCircleObjects, outerRadius, numOuter, outerStartAngle);

        return objects;
    }

    alignSelected(key, funcName) {
        const v = Math[funcName](...this.selectedNodes.map(obj => obj[key]));
        for (const node of this.selectedNodes) {
            const forceNode = {
                id: node.id,
                x: node.x,
                y: node.y,
                fx: node.x,
                fy: node.y,
            }
            forceNode[key] = v;
            forceNode[`f${key}`] = v
            this.renderer.worker.postMessage({forceNode});
        }
        this.renderer.worker.postMessage({
            run: true,
            alpha: 1,
            alphaTarget: 0
        });
        this.addInmemoryHistory();
    }

    patchWorker() {
        // const Worker = this.renderer.worker.constructor;
        // if (!Worker._isProPatched) {
        //     Worker._isProPatched = true;
        //     const origPost = Worker.prototype.postMessage;
        //     Worker.prototype.postMessage = async function (msg, transfer) {
        //         return origPost.call(this, msg, transfer);
        //     }
        // }
    }

    extendMaxSizeInput() {
        const inputs = this.renderer.containerEl.querySelectorAll(
            'div.graph-control-section.mod-display input[type="number"][max="5"]'
        );
        inputs.forEach(input => {
            if (input.max === "5") {
                input.max = "20";
            }
        });
    }

    addGraphControls() {
        const controls = this.renderer.containerEl.querySelector('.graph-controls');
        if (!controls || controls.querySelector('.graph-pro-advanced-section')) return;

        const section = controls.createDiv('tree-item graph-control-section mod-collapsible graph-pro-advanced-section');
        const selfEl = section.createDiv('tree-item-self mod-collapsible');
        selfEl.createDiv('tree-item-icon collapse-icon');
        selfEl.createDiv('tree-item-inner')
            .createEl('header', {cls: 'graph-control-section-header', text: 'Advanced'});
        const children = section.createDiv('tree-item-children');
        const container = children.createDiv('graph-control-container');

        const addTextInput = (labelText, placeholder, initialValue, onChange) => {
            const wrap = container.createDiv('graph-control-item');
            new Setting(wrap)
                .setName(labelText)
                .addText(t =>
                    t.setPlaceholder(placeholder)
                        .setValue(initialValue)
                        .onChange(async v => {
                            onChange(v);
                            await this.plugin.saveSettings();
                        })
                );
        };

        addTextInput('Label regex', '(?<label>...)', this.plugin.settings.labelRegex, v => {
            this.plugin.settings.labelRegex = v;
        });

        addTextInput('Frontmatter field', 'e.g. label or title', this.plugin.settings.frontmatterField, v => {
            this.plugin.settings.frontmatterField = v;
        });
    }

    restoreNodePositions(nodePositions) {
        if (!nodePositions) {
            nodePositions = this.plugin.getCurrentPositionsHistory();
        }

        this.renderer.nodes.forEach((node) => {
            const _node = nodePositions[node.id];
            if (_node) {
                this.renderer.worker.postMessage({
                    forceNode: {
                        id: node.id,
                        x: _node.x,
                        y: _node.y,
                        fx: _node.x,
                        fy: _node.y,
                    }
                });
            }
        });

        this.renderer.worker.postMessage({
            run: true,
            alpha: 1,
            alphaTarget: 0
        });

        // setTimeout(() => {
        //     if (!renderer.worker) return;
        //     nodePositions.forEach((node) => {
        //         renderer.worker.postMessage({
        //             forceNode: { id: node.id, fx: null, fy: null }
        //         });
        //     });
        // }, 5000);
    }

    patchIconGraphics() {
        const nodes = this.renderer.nodes;
        if (!Array.isArray(nodes) || !nodes.length) return;

        const AG = nodes[0].constructor; // AbstractGraphics
        // The patching logic is now in the main plugin class to handle lifecycle correctly.
        // This method just triggers it once.
        this.plugin.patchPrototypes(AG);

        // Force re-initialization for existing nodes if needed, or rely on graph redraw
        this.renderer.setData({nodes: this.renderer.nodes, links: this.renderer.links});
    }

    setupHoverLabels() {
        const unpatch = around(this.renderer, {
            onNodeHover: (originalHover) => (e, nodeId, type) => {
                originalHover.call(this.renderer, e, nodeId, type);
                this.renderNeighborLabels(nodeId);
            },
            onNodeUnhover: (originalUnhover) => (e) => {
                originalUnhover.call(this.renderer, e);
                this.clearNeighborLabels();
            },
            onPointerDown: (originalPointerDown) => (e, i) => {
                originalPointerDown.call(this.renderer, e, i);
                if (this.renderer.dragNode) {
                    this.renderer._dragNode = this.renderer.dragNode;
                    this.renderer._dragStart = {
                        x: this.renderer.dragNode.x,
                        y: this.renderer.dragNode.y
                    };
                } else {
                    delete this.renderer._dragNode;
                    delete this.renderer._dragStart;
                }
            }
        });
        this.unpatchers.push(unpatch);


        this.renderer.px.stage.on("pointerup", () => {
            const dragNodeBeforeUp = this.renderer._dragNode;
            const dragStartBeforeUp = this.renderer._dragStart;

            if (dragNodeBeforeUp) {
                if (this.plugin.settings.snapToGrid) {
                    const gridSize = 500;
                    this.renderer._dragNode.x = Math.round(this.renderer._dragNode.x / gridSize) * gridSize;
                    this.renderer._dragNode.y = Math.round(this.renderer._dragNode.y / gridSize) * gridSize;
                    const forceNode = {
                        id: this.renderer._dragNode.id,
                        x: this.renderer._dragNode.x,
                        y: this.renderer._dragNode.y,
                        fx: this.renderer._dragNode.x,
                        fy: this.renderer._dragNode.y,
                    };
                    this.renderer.worker.postMessage({forceNode});
                }

                if (dragStartBeforeUp && this.selectedNodes &&
                    (this.selectedNodes.size > 0 || (Array.isArray(this.selectedNodes) && this.selectedNodes.length > 0))) {
                    this.dragCoSelectedNodes(dragNodeBeforeUp, dragStartBeforeUp);
                }
            }

            if (this.renderer._dragStart) {
                delete this.renderer._dragStart;
                this.addInmemoryHistory();
            }
        })
    }

    renderNeighborLabels(nodeId) {
        this.clearNeighborLabels();
        if (!this.plugin.settings.showNeighborLabels || !nodeId) return;

        const centralNode = this.renderer.nodeLookup[nodeId];
        if (!centralNode) return;

        const neigh = new Set();
        (this.renderer.links || []).forEach(link => {
            const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
            const targetId = typeof link.target === 'string' ? link.target : link.target.id;
            if (sourceId === nodeId) neigh.add(targetId);
            else if (targetId === nodeId) neigh.add(sourceId);
        });

        neigh.forEach(nid => {
            if (nid === nodeId) return;

            const nodeObj = this.renderer.nodeLookup[nid];
            if (!nodeObj?.x == null || !nodeObj?.y == null || !nodeObj.circle) return;

            let name = nid.substring(nid.lastIndexOf('/') + 1).replace(/\.md$/, '');

            if (this.plugin.settings.frontmatterField) {
                const file = this.app.vault.getAbstractFileByPath(nid);
                if (file) {
                    const cache = this.app.metadataCache.getFileCache(file);
                    const frontmatter = this.getNodeFrontmatter(nid);
                    const fmField = this.plugin.settings.frontmatterField;
                    if (frontmatter && frontmatter[fmField] != null) {
                        name = String(cache.frontmatter[fmField]);
                    }
                }
            } else if (this.plugin.settings.labelRegex) {
                try {
                    const re = new RegExp(this.plugin.settings.labelRegex);
                    const m = name.match(re);
                    if (m?.groups?.label) {
                        name = m.groups.label;
                    }
                } catch (e) {
                    // console.warn("Invalid label regex", e);
                }
            }

            const size = nodeObj.circle?.width;
            let factor = 0
            if (size > 100 && this.renderer.scale > 0.1) {
                factor = (size / 100) * 2;
            }
            const label = new PIXI.Text(name, {fontSize: 20 + factor});
            label.resolution = 2;
            label.zIndex = 2;
            label.anchor.set(0.5, 0);
            label.x = nodeObj.x;
            label.y = nodeObj.y + size + (10 * (1 / this.renderer.scale));
            label.eventMode = 'none';
            label.scale.set((1 / this.renderer.scale));
            this.renderer.hanger.addChild(label);
            this._hoveredNeighborLabels.add(label);
        });
    }

    clearNeighborLabels() {
        this._hoveredNeighborLabels?.forEach(l => l.destroy({children: true}));
        this._hoveredNeighborLabels = new Set();
    }

    setupGrid() {
        const [stageBg, nodesLinksContainer] = this.px.stage.children;
        const grid = new PIXI.Graphics();
        const cellSize = 500;
        const gridSize = 1000000;

        for (let x = 0, i = 0; x <= gridSize; x += cellSize, i++) {
            const color = (i % 2 === 0) ? 0x000 : 0xcccccc;
            grid.lineStyle(5, color, 0.8);
            grid.moveTo(x, 0);
            grid.lineTo(x, gridSize);
        }

        for (let y = 0, i = 0; y <= gridSize; y += cellSize, i++) {
            const color = (i % 2 === 0) ? 0x000 : 0xcccccc;
            grid.lineStyle(5, color, 0.8);
            grid.moveTo(0, y);
            grid.lineTo(gridSize, y);
        }

        grid.position.set(-gridSize / 2, -gridSize / 2);
        nodesLinksContainer.addChild(grid);
        this.grid = grid;
        this.grid.visible = this.plugin.settings.showGrid;
    }

    showGrid(isVisible) {
        this.grid.visible = isVisible;
        this.renderer.px.render()
    }

    runGraphSimulation() {
        // this.renderer.nodes?.forEach(node => {
        //     this.renderer.worker.postMessage({
        //         forceNode: {id: node.id, fx: null, fy: null}
        //     });
        // });
        this.renderer.worker.postMessage({
            run: true,
            alpha: 2,
            alphaDecay: 0.0228,
            alphaTarget: 0
        });
        new Notice("Graph simulation running.");
    }

    stopGraphSimulation() {
        this.renderer.worker.postMessage({
            run: true,
            alpha: 0,
            alphaTarget: 0
        });
        new Notice("Graph simulation stopped.");
    }

    unlockSelectedPositions() {
        for (const node of this.selectedNodes) {
            const forceNode = {
                id: node.id,
                fx: null,
                fy: null,
            }
            this.renderer.worker.postMessage({forceNode});
        }
        this.renderer.worker.postMessage({
            run: true,
            alpha: 1,
            alphaTarget: 0
        });
    }

    copyGPTPromptToClipboard() {
        const selectedNodes = this.selectedNodes;
        if (selectedNodes && selectedNodes.length) {
            const uniqueNodes = {};
            selectedNodes.forEach(node => {
                const metadata = {}
                const frontmatter = this.getNodeFrontmatter(node.id);
                if (frontmatter) {
                    const keysToTrack = ['cluster', 'namespace', 'service'];
                    for (const key of keysToTrack) {
                        if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
                            const value = frontmatter[key];
                            if (value) {
                                metadata[key] = value;
                            }
                        }
                    }
                }
                uniqueNodes[node.id] = {
                    x: Math.floor(node.x),
                    y: Math.floor(node.y),
                    color: node.color,
                    metadata: metadata,
                    links: {
                        forward: [],
                        reverse: [],
                    }
                }
            })
            selectedNodes.forEach(node => {
                const forward = Object.keys(node.forward).filter(i => i in uniqueNodes);
                const reverse = Object.keys(node.reverse).filter(i => i in uniqueNodes);
                uniqueNodes[node.id]['links'] = {forward, reverse};
            })
            const jsonString = JSON.stringify(uniqueNodes);
            navigator.clipboard.writeText(GPT_BASE_PROMPT + jsonString).then(() => {
                new Notice("Prompt copied to clipboard");
            }).catch(err => {
                // console.error("Failed to copy JSON:", err);
                new Notice("Failed to copy Prompt");
            });
        }
    }

    async updateNodesPositionFromClipboard() {
        const text = await navigator.clipboard.readText();
        try {
            const json = JSON.parse(text);
            for (const jsonKey in json) {
                const node = json[jsonKey];
                const forceNode = {
                    id: jsonKey,
                    x: node.x,
                    y: node.y,
                    fx: node.x,
                    fy: node.y,
                }
                this.renderer.worker.postMessage({forceNode});
            }
            this.renderer.worker.postMessage({
                run: true,
                alpha: 0.1,
                alphaTarget: 0
            });
            new Notice("JSON read from clipboard.");
            this.addInmemoryHistory();
        } catch (e) {
            // console.log(e);
            new Notice("Clipboard doesn't contain valid JSON. ");
        }
    }
}
