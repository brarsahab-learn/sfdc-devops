// AuditTrailPanel.ts — shows the local audit trail inside VS Code (a full editor-area
// panel), instead of opening the generated HTML file in the system browser.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { renderAuditHtml } from "../AuditLog";

export class AuditTrailPanel {
    private static current: AuditTrailPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(gitHelper: GitHelper) {
        if (AuditTrailPanel.current) {
            AuditTrailPanel.current._panel.reveal(vscode.ViewColumn.One);
            AuditTrailPanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "sfDevopsAuditTrail",
            "SF DevOps Audit Trail",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        AuditTrailPanel.current = new AuditTrailPanel(panel, gitHelper);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _gitHelper: GitHelper
    ) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this.refresh();
    }

    public dispose() {
        AuditTrailPanel.current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    public async refresh() {
        try {
            const entries = await this._gitHelper.getAuditEntries();
            this._panel.webview.html = renderAuditHtml(entries);
        } catch (err) {
            this._panel.webview.html = `<body style="padding:16px;color:#f48771;font-family:sans-serif">Error: ${String(err)}</body>`;
        }
    }
}
