// PipelineTreeProvider.ts — Shows live pipeline status in sidebar tree view

import * as vscode from "vscode";
import { IGitProviderClient, PipelineRun } from "../GitProviderClient";

export class PipelineTreeProvider implements vscode.TreeDataProvider<PipelineItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PipelineItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly _bbClient: IGitProviderClient) {}

    refresh(): void { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(element: PipelineItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<PipelineItem[]> {
        try {
            const runs = await this._bbClient.getLatestPipelines(8);
            return runs.map((r) => new PipelineItem(r));
        } catch {
            return [new PipelineItem(null, "Configure your Git provider settings first")];
        }
    }
}

class PipelineItem extends vscode.TreeItem {
    constructor(run: PipelineRun | null, fallbackLabel?: string) {
        if (!run) {
            super(fallbackLabel ?? "No pipelines found", vscode.TreeItemCollapsibleState.None);
            return;
        }

        const icon  = run.state === "COMPLETED"
            ? (run.result === "SUCCESSFUL" ? "✅" : "❌")
            : run.state === "IN_PROGRESS" ? "⚙️" : "⏸";

        super(
            `${icon} ${run.branch} — #${run.id}`,
            vscode.TreeItemCollapsibleState.None
        );

        this.description = run.result || run.state;
        this.tooltip     = `Branch: ${run.branch}\nCommit: ${run.commit}\nStatus: ${run.state} ${run.result}`;
        this.command     = {
            command:   "vscode.open",
            title:     "Open Pipeline",
            arguments: [vscode.Uri.parse(run.url)],
        };
    }
}
