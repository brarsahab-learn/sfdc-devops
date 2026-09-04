// CoveragePanel.ts — Apex code coverage check, opened as a full editor panel (right side).
// Replaces the old sidebar CoverageWebviewProvider. Opens automatically when a story has
// Apex classes and the coverage gate has not yet been satisfied.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { StoryWebviewProvider } from "./StoryWebviewProvider";
import {
    runApexCoverage, coverageSettings, CoverageResult, findRelatedTestClasses,
} from "../commands/coverageCheck";
import {
    extractStoryId, isFeatureBranch, getCoverageGateEnvironment, getSourceRootFolder,
} from "../config";

export class CoveragePanel {
    private static _current: CoveragePanel | undefined;

    static createOrShow(gitHelper: GitHelper, storyProvider: StoryWebviewProvider): void {
        if (CoveragePanel._current) {
            CoveragePanel._current._panel.reveal(vscode.ViewColumn.Two);
            CoveragePanel._current._refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "sfDevopsCoverage",
            "Code Coverage",
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        CoveragePanel._current = new CoveragePanel(panel, gitHelper, storyProvider);
    }

    /** Open (or refresh) the panel only when the story has Apex classes and coverage is not yet passed.
     *  Returns true if the panel was opened, false if nothing to do. */
    static async openIfNeeded(gitHelper: GitHelper, storyProvider: StoryWebviewProvider): Promise<boolean> {
        const branch  = await gitHelper.currentBranch();
        const storyId = isFeatureBranch(branch) ? extractStoryId(branch) : "";
        if (!storyId) { return false; }
        const apex   = await gitHelper.featureApexClasses(storyId);
        if (apex.length === 0) { return false; }
        const passed = await gitHelper.isCoveragePassed(storyId);
        if (passed) { return false; }
        CoveragePanel.createOrShow(gitHelper, storyProvider);
        return true;
    }

    static refreshIfOpen(): void {
        CoveragePanel._current?._refresh();
    }

    private readonly _disposables: vscode.Disposable[] = [];
    private _lastResult?: CoverageResult;
    private _lastTests  = "";
    private _missingTests: string[] = [];

    private constructor(
        private readonly _panel:         vscode.WebviewPanel,
        private readonly _gitHelper:     GitHelper,
        private readonly _storyProvider: StoryWebviewProvider,
    ) {
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg: { command: string; testNames?: string }) => {
            if (msg.command === "runCoverage")     { await this._runCheck(msg.testNames ?? ""); }
            if (msg.command === "refresh")          { await this._refresh(); }
            if (msg.command === "autoDetectTests")  { this._lastTests = ""; await this._refresh(); }
        }, null, this._disposables);
        this._panel.webview.html = this._loadingHtml();
        this._refresh();
    }

    private _dispose(): void {
        CoveragePanel._current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    private async _refresh(): Promise<void> {
        try {
            const branch  = await this._gitHelper.currentBranch();
            const storyId = isFeatureBranch(branch) ? extractStoryId(branch) : "";
            const apex    = storyId ? await this._gitHelper.featureApexClasses(storyId) : [];
            const passed  = storyId ? await this._gitHelper.isCoveragePassed(storyId) : false;
            const stale   = storyId && !passed ? await this._gitHelper.isCoverageStale(storyId) : false;

            this._missingTests = [];
            if (apex.length > 0 && !this._lastTests && branch) {
                const { found, missing } = await this._detectRelatedTests(branch, apex);
                this._lastTests = found.join(", ");
                this._missingTests = missing;
            }

            this._panel.title = storyId ? `Coverage — ${storyId}` : "Code Coverage";
            this._panel.webview.html = this._renderHtml(branch ?? "", storyId, apex, passed, stale);
        } catch (err) {
            this._panel.webview.html = `<body style="padding:20px;color:#f48771;font-family:sans-serif">Error: ${String(err)}</body>`;
        }
    }

    private async _detectRelatedTests(branch: string, apex: string[]) {
        const sourceRoot = getSourceRootFolder();
        const files = await this._gitHelper.listFilesAtRef(branch, sourceRoot);
        const basenames = new Set(
            files.filter(f => f.endsWith(".cls")).map(f => f.split("/").pop()!.replace(/\.cls$/, ""))
        );
        return findRelatedTestClasses(apex, basenames);
    }

    private async _runCheck(testNames: string): Promise<void> {
        const branch  = await this._gitHelper.currentBranch();
        const storyId = isFeatureBranch(branch) ? extractStoryId(branch) : "";
        if (!storyId) {
            vscode.window.showWarningMessage("Switch to a feature branch to run the coverage check.");
            return;
        }

        this._lastTests = testNames;
        const tests = testNames.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
        const apex  = await this._gitHelper.featureApexClasses(storyId);
        const { threshold, sourceOrgAlias, sourceOrgLabel } = coverageSettings();
        const root  = this._gitHelper.getWorkspaceRoot();

        if (!sourceOrgAlias) {
            vscode.window.showWarningMessage(
                `No org alias configured for ${sourceOrgLabel} — set sfDevops.devOrgAlias (or that environment's orgAlias) before running the coverage check.`
            );
            return;
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Running Apex tests in ${sourceOrgLabel}…`, cancellable: false },
            async () => {
                const result = await runApexCoverage(root, apex, tests, threshold, sourceOrgAlias);
                this._lastResult = result;

                const testResults = { passed: result.passed, threshold, testsFailed: result.testsFailed, perClass: result.perClass };

                if (result.error) {
                    await this._gitHelper.appendAudit({
                        operation: "runTests", storyId, outcome: "failure",
                        summary: "Coverage check failed to run", details: { error: result.error },
                    });
                    vscode.window.showErrorMessage(`Coverage check: ${result.error}`);
                } else if (result.passed) {
                    await this._gitHelper.recordCoveragePassed(storyId, {
                        threshold, tests, classes: apex, perClass: result.perClass,
                    });
                    await this._gitHelper.appendAudit({
                        operation: "runTests", storyId, outcome: "success",
                        summary: `Coverage passed (≥ ${threshold}%)`, details: { testResults },
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
                        summary: "Coverage below threshold or tests failed", details: { testResults },
                    });
                    vscode.window.showWarningMessage(
                        result.testsFailed > 0
                            ? `❌ ${result.testsFailed} test(s) failed — fix them and re-run.`
                            : `❌ Below ${threshold}%: ${failed}. Add coverage and re-run.`
                    );
                }
                await this._refresh();
            }
        );
    }

    private _loadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">Loading coverage…</body></html>`;
    }

    private _renderHtml(branch: string, storyId: string, apex: string[], passed: boolean, stale: boolean): string {
        const onFeature = isFeatureBranch(branch);
        const gateEnv   = getCoverageGateEnvironment();
        const gateLabel = gateEnv?.label ?? "the gated environment";

        let mainContent: string;
        if (!onFeature) {
            mainContent = `<div class="banner info">Switch to a feature branch to check code coverage.</div>`;
        } else if (apex.length === 0) {
            mainContent = `<div class="banner ok">✅ No Apex classes in this story — no coverage gate required. You can promote to ${escapeHtml(gateLabel)}.</div>`;
        } else {
            const { threshold, sourceOrgLabel, sourceOrgAlias } = coverageSettings();

            const gateBanner = passed
                ? `<div class="banner ok">✅ Coverage gate passed — ${escapeHtml(gateLabel)} promotion unlocked.</div>`
                : stale
                ? `<div class="banner warn">⚠ Coverage passed before, but a class or test class changed — re-run before promoting to ${escapeHtml(gateLabel)}.</div>`
                : `<div class="banner warn">⚠ Coverage gate not yet passed. Run the related tests (≥ ${threshold}%) in <strong>${escapeHtml(sourceOrgLabel)}</strong>${sourceOrgAlias ? ` (${escapeHtml(sourceOrgAlias)})` : ""} — that's where these changes currently are.</div>`;

            const classRows = apex.map(c =>
                `<tr><td class="cls-name">${escapeHtml(c)}</td><td>${
                    this._lastResult?.perClass.find(r => r.name === c)
                        ? (() => { const r = this._lastResult!.perClass.find(rr => rr.name === c)!;
                            return `<span class="${r.pass ? "pct-ok" : "pct-fail"}">${r.percent}%</span>`; })()
                        : "<span class='pct-na'>not run</span>"
                }</td></tr>`
            ).join("");

            const resultExtra = this._lastResult?.ran && !this._lastResult.error
                ? (this._lastResult.testsFailed > 0
                    ? `<div class="banner warn" style="margin-top:8px">❌ ${this._lastResult.testsFailed} test(s) failed — fix them and re-run.</div>`
                    : "")
                : "";

            const missingHint = this._missingTests.length
                ? `<div class="banner warn">⚠ No test class auto-detected for: ${escapeHtml(this._missingTests.join(", "))} — add one manually below.</div>`
                : "";

            mainContent = `
${gateBanner}

<div class="section">
  <div class="section-head">Apex classes in this story</div>
  <table class="cls-table">
    <thead><tr><th>Class</th><th>Coverage</th></tr></thead>
    <tbody>${classRows}</tbody>
  </table>
  ${resultExtra}
</div>

<div class="section">
  <div class="section-head">Run tests</div>
  <label>Test class names <a href="#" onclick="send('autoDetectTests')" class="link">🔍 auto-detect</a></label>
  <textarea id="tests" rows="3" placeholder="e.g. DemoServiceTest, AccountTriggerTest">${escapeHtml(this._lastTests)}</textarea>
  ${missingHint}
  <button class="btn btn-primary" onclick="run()">▶ Run Tests &amp; Check Coverage</button>
  <div class="hint">Threshold: ${threshold}% per class · Org: ${escapeHtml(sourceOrgLabel)}${sourceOrgAlias ? ` (${escapeHtml(sourceOrgAlias)})` : ""}</div>
</div>`;
        }

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { --bg:#1e1e1e; --fg:#e0e0e0; --card:#252526; --border:#3c3c3c; --muted:#888; --accent:#4fc3f7; --ok:#7cd992; --warn:#ffab70; --err:#ff6b6b; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fff; --fg:#1a1a1a; --card:#f5f5f5; --border:#ddd; --muted:#666; --accent:#0078d4; --ok:#1b6b2f; --warn:#a05000; --err:#c62828; }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 20px 28px 60px; max-width: 800px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .subtitle { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
  .btn { font-size: 12px; padding: 6px 14px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; background: transparent; color: var(--fg); }
  .btn-primary { background: #0078d4; color: #fff; border-color: #0078d4; font-size: 13px; padding: 8px 20px; margin-top: 8px; }
  .btn:hover { opacity: 0.85; }

  .banner { border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; }
  .banner.ok   { background: color-mix(in srgb, var(--ok)   12%, var(--bg)); border: 1px solid var(--ok);   color: var(--ok); }
  .banner.warn { background: color-mix(in srgb, var(--warn) 12%, var(--bg)); border: 1px solid var(--warn); }
  .banner.info { background: color-mix(in srgb, var(--accent) 10%, var(--bg)); border: 1px solid var(--accent); color: var(--muted); }

  .section { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .section-head { font-weight: 600; font-size: 13px; margin-bottom: 10px; }

  .cls-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .cls-table th { text-align: left; padding: 4px 8px; border-bottom: 2px solid var(--border); color: var(--muted); font-size: 11px; }
  .cls-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); }
  .cls-name { word-break: break-all; }
  .pct-ok   { color: var(--ok); font-weight: 600; }
  .pct-fail { color: var(--err); font-weight: 600; }
  .pct-na   { color: var(--muted); }

  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  textarea { width: 100%; font-size: 12px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg); resize: vertical; }
  .hint { font-size: 11px; color: var(--muted); margin-top: 6px; }
  .link { color: var(--accent); text-decoration: none; font-weight: normal; }
  .link:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>🧪 Code Coverage</h1>
<div class="subtitle">${storyId ? escapeHtml(storyId) + " · " : ""}${escapeHtml(branch || "no branch")}</div>

<div class="toolbar">
  <button class="btn" onclick="send('refresh')">↻ Refresh</button>
</div>

${mainContent}

<script>
  const vscode = acquireVsCodeApi();
  function send(cmd) { vscode.postMessage({ command: cmd }); }
  function run() {
    var el = document.getElementById('tests');
    vscode.postMessage({ command: 'runCoverage', testNames: el ? el.value : '' });
  }
</script>
</body>
</html>`;
    }
}

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
}
