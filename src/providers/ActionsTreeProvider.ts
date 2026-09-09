// ActionsTreeProvider.ts — Sidebar "Actions" section with clickable shortcut items.

import * as vscode from "vscode";

interface ActionItem {
    label:   string;
    icon:    string;
    command: string;
    tooltip: string;
    when?:   () => boolean;
}

const ACTIONS: ActionItem[] = [
    { label: "Data Migration",          icon: "database",      command: "sfDevops.openDataMigration",        tooltip: "Open Data Migration panel" },
    { label: "Pipeline View",           icon: "graph",         command: "sfDevops.openPipelineView",         tooltip: "Open story pipeline kanban" },
    { label: "Deployment Dashboard",    icon: "rocket",        command: "sfDevops.openDeploymentDashboard",  tooltip: "Open deployment dashboard" },
    { label: "Admin / Setup",           icon: "shield",        command: "sfDevops.openAdminPanel",           tooltip: "Open admin and setup panel" },
    { label: "Story Journey",           icon: "history",       command: "sfDevops.openStoryJourney",         tooltip: "View story lifecycle history" },
    { label: "Audit Trail",             icon: "checklist",     command: "sfDevops.viewAuditLog",             tooltip: "View deployment audit trail" },
    { label: "Code Coverage",           icon: "beaker",        command: "sfDevops.runCoverage",              tooltip: "Run Apex code coverage" },
    { label: "Compare Branches",        icon: "diff",          command: "sfDevops.openDiffViewer",           tooltip: "Open branch diff viewer" },
    { label: "Pending Actions",         icon: "zap",           command: "sfDevops.viewPendingActions",       tooltip: "View stories pending your action" },
];

class ActionTreeItem extends vscode.TreeItem {
    constructor(action: ActionItem) {
        super(action.label, vscode.TreeItemCollapsibleState.None);
        this.iconPath  = new vscode.ThemeIcon(action.icon);
        this.tooltip   = action.tooltip;
        this.command   = { command: action.command, title: action.label, arguments: [] };
    }
}

export class ActionsTreeProvider implements vscode.TreeDataProvider<ActionTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ActionTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ActionTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): ActionTreeItem[] {
        return ACTIONS.map(a => new ActionTreeItem(a));
    }
}
