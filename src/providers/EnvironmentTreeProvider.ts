// EnvironmentTreeProvider.ts — Shows which version is deployed in each org.
// Reads the environment list from sfDevops.environments (the same setting every other
// part of the extension uses) — no separate config file, no hardcoded fallback list.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { getEnvironments, ResolvedEnvironment } from "../config";

export class EnvironmentTreeProvider implements vscode.TreeDataProvider<EnvItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<EnvItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly _bbClient: IGitProviderClient) {}

    refresh(): void { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(element: EnvItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<EnvItem[]> {
        const envs = getEnvironments();
        try {
            const pipelines = await this._bbClient.getLatestPipelines(20);

            return envs.map((env) => {
                const latest = pipelines.find(
                    (p) => p.branch === env.branch && p.result === "SUCCESSFUL"
                );
                return new EnvItem(env, latest?.commit ?? "unknown", latest?.createdOn);
            });
        } catch {
            return envs.map((env) => new EnvItem(env, "—"));
        }
    }
}

class EnvItem extends vscode.TreeItem {
    constructor(env: ResolvedEnvironment, commit: string, deployedAt?: string) {
        super(env.label, vscode.TreeItemCollapsibleState.None);

        this.description = commit !== "unknown" ? `${commit}` : "—";
        this.tooltip     = deployedAt
            ? `Last deployed: ${new Date(deployedAt).toLocaleString()}`
            : "No deployments found";

        this.iconPath = new vscode.ThemeIcon(env.icon);
    }
}
