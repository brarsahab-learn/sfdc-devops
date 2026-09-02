// EnvironmentTreeProvider.ts — Shows which version is deployed in each org.
// Reads the environment list from sfDevops.environments (the same setting every other
// part of the extension uses), and the last-deployed commit from the local deploy-state
// file GitHelper tracks whenever a real deploy runs from the Deployment Dashboard — that's
// the actual source of truth now that every deploy originates from this extension, not an
// external CI pipeline (there usually isn't one to query any more).

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { getEnvironments, ResolvedEnvironment } from "../config";

export class EnvironmentTreeProvider implements vscode.TreeDataProvider<EnvItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<EnvItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly _gitHelper: GitHelper) {}

    refresh(): void { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(element: EnvItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<EnvItem[]> {
        const envs = getEnvironments();
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

export class EnvItem extends vscode.TreeItem {
    /** The org alias this row represents — "" when none is configured yet (view icon handler checks this before running `sf org open`). */
    readonly orgAlias: string;
    readonly envLabel: string;

    constructor(
        env: ResolvedEnvironment,
        lastDeploy: { sha: string; deployedAt: string; numberComponentsDeployed?: number } | null,
        pending: boolean
    ) {
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
            command:   "sfDevops.openDeploymentDashboard",
            title:     `Open ${env.label} in the Deployment Dashboard`,
            arguments: [env.name],
        };

        // The org name up front, then the branch it's fed from, then deploy status — in that
        // order, since "which real Salesforce org is this" is the thing worth seeing at a
        // glance before the git-side detail. No org alias configured yet shows as an explicit
        // gap rather than silently vanishing from the row.
        const shortSha = lastDeploy?.sha ? lastDeploy.sha.slice(0, 8) : null;
        const orgPart    = env.orgAlias ? env.orgAlias : "⚠ no org alias set";
        const deployPart = shortSha ? `${shortSha}${pending ? " (behind)" : ""}` : "not deployed yet";
        this.description = `${orgPart} · ${env.branch} · ${deployPart}`;

        if (!lastDeploy) {
            this.tooltip = `Org: ${orgPart}\nBranch: ${env.branch}\nNo deploy recorded for ${env.label} yet — run a Deploy from the Deployment Dashboard.`;
            this.iconPath = new vscode.ThemeIcon("circle-outline");
        } else {
            const deployedAt = new Date(lastDeploy.deployedAt).toLocaleString();
            const components  = lastDeploy.numberComponentsDeployed !== undefined
                ? `, ${lastDeploy.numberComponentsDeployed} component(s)`
                : "";
            this.tooltip = pending
                ? `Org: ${orgPart}\nBranch: ${env.branch}\nLast deployed: ${deployedAt}${components}\n${env.branch} has newer commits not yet deployed.`
                : `Org: ${orgPart}\nBranch: ${env.branch}\nLast deployed: ${deployedAt}${components}\nUp to date with ${env.branch}.`;
            this.iconPath = new vscode.ThemeIcon(pending ? "warning" : env.icon);
        }
    }
}
