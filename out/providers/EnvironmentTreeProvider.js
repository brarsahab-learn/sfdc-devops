"use strict";
// EnvironmentTreeProvider.ts — Shows which version is deployed in each org.
// Reads the environment list from sfDevops.environments (the same setting every other
// part of the extension uses), and the last-deployed commit from the local deploy-state
// file GitHelper tracks whenever a real deploy runs from the Deployment Dashboard — that's
// the actual source of truth now that every deploy originates from this extension, not an
// external CI pipeline (there usually isn't one to query any more).
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
exports.EnvItem = exports.EnvironmentTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
const config_1 = require("../config");
class EnvironmentTreeProvider {
    constructor(_gitHelper) {
        this._gitHelper = _gitHelper;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() { this._onDidChangeTreeData.fire(undefined); }
    getTreeItem(element) { return element; }
    async getChildren() {
        const envs = (0, config_1.getEnvironments)();
        return Promise.all(envs.map(async (env) => {
            const [lastDeploy, branchHeadSha] = await Promise.all([
                this._gitHelper.getDeployState(env.name),
                this._gitHelper.remoteHeadSha(env.branch),
            ]);
            const pending = Boolean(lastDeploy && branchHeadSha && lastDeploy.sha !== branchHeadSha);
            return new EnvItem(env, lastDeploy, pending);
        }));
    }
}
exports.EnvironmentTreeProvider = EnvironmentTreeProvider;
class EnvItem extends vscode.TreeItem {
    constructor(env, lastDeploy, pending) {
        super(env.label, vscode.TreeItemCollapsibleState.None);
        this.orgAlias = env.orgAlias ?? "";
        this.envLabel = env.label;
        // Lets the inline "open org" icon (contributed in package.json's view/item/context,
        // scoped to this contextValue) show up only on these rows.
        this.contextValue = "sfDevopsEnvItem";
        // Clicking any environment here opens the Deployment Dashboard bound to exactly that
        // one (see DeploymentDashboardPanel._boundEnv) — the same entry point Story Progress's
        // 🚀 links use, just reachable from this read-only list too.
        this.command = {
            command: "sfDevops.openDeploymentDashboard",
            title: `Open ${env.label} in the Deployment Dashboard`,
            arguments: [env.name],
        };
        // The org name up front, then the branch it's fed from, then deploy status — in that
        // order, since "which real Salesforce org is this" is the thing worth seeing at a
        // glance before the git-side detail. No org alias configured yet shows as an explicit
        // gap rather than silently vanishing from the row.
        const shortSha = lastDeploy?.sha ? lastDeploy.sha.slice(0, 8) : null;
        const orgPart = env.orgAlias ? env.orgAlias : "⚠ no org alias set";
        const deployPart = shortSha ? `${shortSha}${pending ? " (behind)" : ""}` : "not deployed yet";
        this.description = `${orgPart} · ${env.branch} · ${deployPart}`;
        if (env.locked) {
            this.iconPath = new vscode.ThemeIcon("lock");
            this.description = `🔴 Locked · ${orgPart} · ${env.branch}`;
            this.tooltip = `⛔ This environment is locked by Admin — no promotions or deploys allowed.\nOrg: ${orgPart}\nBranch: ${env.branch}`;
        }
        else if (!lastDeploy) {
            this.tooltip = `Org: ${orgPart}\nBranch: ${env.branch}\nNo deploy recorded for ${env.label} yet — run a Deploy from the Deployment Dashboard.`;
            this.iconPath = new vscode.ThemeIcon("circle-outline");
        }
        else {
            const deployedAt = new Date(lastDeploy.deployedAt).toLocaleString();
            const components = lastDeploy.numberComponentsDeployed !== undefined
                ? `, ${lastDeploy.numberComponentsDeployed} component(s)`
                : "";
            this.tooltip = pending
                ? `Org: ${orgPart}\nBranch: ${env.branch}\nLast deployed: ${deployedAt}${components}\n${env.branch} has newer commits not yet deployed.`
                : `Org: ${orgPart}\nBranch: ${env.branch}\nLast deployed: ${deployedAt}${components}\nUp to date with ${env.branch}.`;
            this.iconPath = new vscode.ThemeIcon(pending ? "warning" : env.icon);
        }
    }
}
exports.EnvItem = EnvItem;
//# sourceMappingURL=EnvironmentTreeProvider.js.map