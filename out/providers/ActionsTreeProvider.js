"use strict";
// ActionsTreeProvider.ts — Sidebar "Actions" section with clickable shortcut items.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionsTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
const ACTIONS = [
    { label: "Data Migration", icon: "database", command: "sfDevops.openDataMigration", tooltip: "Open Data Migration panel" },
    { label: "Pipeline View", icon: "graph", command: "sfDevops.openPipelineView", tooltip: "Open story pipeline kanban" },
    { label: "Deployment Dashboard", icon: "rocket", command: "sfDevops.openDeploymentDashboard", tooltip: "Open deployment dashboard" },
    { label: "Admin / Setup", icon: "shield", command: "sfDevops.openAdminPanel", tooltip: "Open admin and setup panel" },
    { label: "Story Journey", icon: "history", command: "sfDevops.openStoryJourney", tooltip: "View story lifecycle history" },
    { label: "Audit Trail", icon: "checklist", command: "sfDevops.viewAuditLog", tooltip: "View deployment audit trail" },
    { label: "Code Coverage", icon: "beaker", command: "sfDevops.runCoverage", tooltip: "Run Apex code coverage" },
    { label: "Compare Branches", icon: "diff", command: "sfDevops.openDiffViewer", tooltip: "Open branch diff viewer" },
    { label: "Pending Actions", icon: "zap", command: "sfDevops.viewPendingActions", tooltip: "View stories pending your action" },
];
class ActionTreeItem extends vscode.TreeItem {
    constructor(action) {
        super(action.label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(action.icon);
        this.tooltip = action.tooltip;
        this.command = { command: action.command, title: action.label, arguments: [] };
    }
}
class ActionsTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        return ACTIONS.map(a => new ActionTreeItem(a));
    }
}
exports.ActionsTreeProvider = ActionsTreeProvider;
//# sourceMappingURL=ActionsTreeProvider.js.map