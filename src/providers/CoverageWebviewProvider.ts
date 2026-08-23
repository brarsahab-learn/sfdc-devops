// CoverageWebviewProvider.ts — "Code Coverage" panel.
// Lets the developer enter test class names, runs them in the dev org, and shows
// per-class coverage. On pass it records the one-time gate marker for the story.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { StoryWebviewProvider } from "./StoryWebviewProvider";
import { runApexCoverage, coverageSettings, CoverageResult } from "../commands/coverageCheck";
import { extractStoryId, isFeatureBranch, getCoverageGateEnvironment } from "../config";

export class CoverageWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "sfDevopsCoverageView";
    private _view?: vscode.WebviewView;
    private _lastResult?: CoverageResult;
    private _lastTests = "";

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _gitHelper: GitHelper,
        private readonly _storyProvider: StoryWebviewProvider
    ) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };

        webviewView.webview.onDidReceiveMessage(async (msg: { command: string; testNames?: string }) => {
            if (msg.command === "runCoverage") {
                await this._runCheck(msg.testNames ?? "");
            } else if (msg.command === "refresh") {
                this.refresh();
            }
        });

        this.refresh();
    }

    public async refresh() {
        if (!this._view) { return; }
        try {
            const branch  = await this._gitHelper.currentBranch();
            const storyId = isFeatureBranch(branch) ? extractStoryId(branch) : "";
            const apex    = storyId ? await this._gitHelper.featureApexClasses(storyId) : [];
            const passed  = storyId ? await this._gitHelper.isCoveragePassed(storyId) : false;
            this._view.webview.html = this._html(branch ?? "", storyId, apex, passed);
        } catch (err) {
            this._view.webview.html = `<body style="padding:8px;color:#f48771">Error: ${String(err)}</body>`;
        }
    }

    private async _runCheck(testNames: string) {
        const branch  = await this._gitHelper.currentBranch();
        const storyId = isFeatureBranch(branch) ? extractStoryId(branch) : "";
        if (!storyId) {
            vscode.window.showWarningMessage("Switch to a feature branch to run the coverage check.");
            return;
        }

        this._lastTests = testNames;
        const tests = testNames.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
        const apex  = await this._gitHelper.featureApexClasses(storyId);
        const { threshold, devOrgAlias } = coverageSettings();
        const root  = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Running Apex tests in the dev org...`, cancellable: false },
            async () => {
                const result = await runApexCoverage(root, apex, tests, threshold, devOrgAlias);
                this._lastResult = result;

                const testResults = {
                    passed: result.passed, threshold, testsFailed: result.testsFailed, perClass: result.perClass,
                };

                if (result.error) {
                    await this._gitHelper.appendAudit({
                        operation: "runTests", storyId, outcome: "failure",
                        summary: "Coverage check failed to run",
                        details: { error: result.error },
                    });
                    vscode.window.showErrorMessage(`Coverage check: ${result.error}`);
                } else if (result.passed) {
                    await this._gitHelper.recordCoveragePassed(storyId, {
                        threshold, tests, classes: apex,
                        perClass: result.perClass,
                    });
                    await this._gitHelper.appendAudit({
                        operation: "runTests", storyId, outcome: "success",
                        summary: `Coverage passed (≥ ${threshold}%)`,
                        details: { testResults },
                    });
                    const gateEnv = getCoverageGateEnvironment();
                    vscode.window.showInformationMessage(
                        `✅ Coverage passed (≥ ${threshold}%). ${storyId} can now be promoted to ${gateEnv?.label ?? "the gated environment"}.`
                    );
                    this._storyProvider.refresh();
                } else {
                    const failed = result.perClass.filter(c => !c.pass).map(c => `${c.name} ${c.percent}%`).join(", ");
                    await this._gitHelper.appendAudit({
                        operation: "runTests", storyId, outcome: "failure",
                        summary: `Coverage below threshold or tests failed`,
                        details: { testResults },
                    });
                    vscode.window.showWarningMessage(
                        result.testsFailed > 0
                            ? `❌ ${result.testsFailed} test(s) failed — fix them and re-run.`
                            : `❌ Below ${threshold}%: ${failed}. Add coverage and re-run.`
                    );
                }
                this.refresh();
            }
        );
    }

    private _html(branch: string, storyId: string, apex: string[], passed: boolean): string {
        const onFeature = isFeatureBranch(branch);
        const gateEnv   = getCoverageGateEnvironment();
        const gateLabel = gateEnv?.label ?? "the gated environment";

        let body: string;
        if (!onFeature) {
            body = `<div class="info">Switch to a feature branch to check code coverage.</div>`;
        } else if (apex.length === 0) {
            body = `<div class="ok">✅ No Apex classes in this story — no coverage gate required. You can promote to ${gateLabel}.</div>`;
        } else {
            const classRows = apex.map(c => `<div class="cls">• ${c}</div>`).join("");
            const gate = passed
                ? `<div class="ok">✅ Coverage gate passed — ${gateLabel} promotion unlocked.</div>`
                : `<div class="warn">⚠ Coverage gate not passed yet. Run the related tests (≥ ${coverageSettings().threshold}%).</div>`;

            const resultBlock = this._lastResult && this._lastResult.ran && !this._lastResult.error
                ? `<div class="divider"></div><b>Last run</b>` +
                  this._lastResult.perClass.map(c =>
                    `<div class="row"><span>${c.name}</span><span style="color:${c.pass ? "#36a64f" : "#f48771"}">${c.percent}%</span></div>`
                  ).join("") +
                  (this._lastResult.testsFailed > 0 ? `<div class="warn">${this._lastResult.testsFailed} test(s) failed</div>` : "")
                : "";

            body = `
                ${gate}
                <div class="divider"></div>
                <b>Apex in this story</b>
                ${classRows}
                <div class="divider"></div>
                <label>Related test class names</label>
                <textarea id="tests" placeholder="e.g. DemoServiceTest, AccountTriggerTest">${this._lastTests}</textarea>
                <button class="btn btn-primary" onclick="run()">▶ Run Tests &amp; Check Coverage</button>
                ${resultBlock}
            `;
        }

        return `<!DOCTYPE html>
<html><head><style>
  body    { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); }
  .card   { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; }
  .story  { font-size: 14px; font-weight: bold; margin-bottom: 6px; }
  .cls    { font-size: 11px; padding: 2px 0; }
  .row    { display: flex; justify-content: space-between; font-size: 11px; padding: 2px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  label   { display: block; font-size: 11px; color: #aaa; margin: 6px 0 2px; }
  textarea{ width: 100%; box-sizing: border-box; min-height: 48px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .btn    { display: block; width: 100%; padding: 7px; margin: 6px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-primary { background: #0078d4; color: white; }
  .info   { background: #1e3a5f; color: #90caf9; border-radius: 4px; padding: 6px 8px; font-size: 11px; }
  .ok     { background: #14351f; color: #7ee2a8; border-radius: 4px; padding: 6px 8px; font-size: 11px; }
  .warn   { background: #5a4a00; color: #ffd700; border-radius: 4px; padding: 6px 8px; font-size: 11px; }
  .divider{ border-top: 1px solid var(--vscode-panel-border); margin: 8px 0; }
</style></head>
<body>
  <div class="card">
    <div class="story">${storyId || "No active story"}</div>
    ${body}
    <div style="text-align:right; font-size:10px; color:#666; margin-top:6px">
      <a href="#" onclick="send('refresh')" style="color:#4fc3f7">↻ refresh</a>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  function send(cmd) { vscode.postMessage({ command: cmd }); }
  function run() {
    const el = document.getElementById('tests');
    vscode.postMessage({ command: 'runCoverage', testNames: el ? el.value : '' });
  }
</script>
</body></html>`;
    }
}
