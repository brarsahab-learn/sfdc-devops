// DeploymentDashboardPanel.ts — full-screen "Deployment Dashboard".
// Shows, per environment, what's merged-but-not-deployed since this extension last ran
// a real `sf project deploy` there, grouped by the story/PR that introduced each change,
// as a checkbox tree (left) with a live color-coded diff (right) for whatever's selected.
// No external CI involved — Validate/Deploy run `sf project deploy` directly from here.

import * as vscode from "vscode";
import { GitHelper, warnUncommittedChanges } from "../GitHelper";
import { runDeploy, DeployMode, DeployResult } from "../DeploymentEngine";
import {
    groupChangesByStory, resolveSelection, DeploySelection, StoryChangeGroup, CommitInfo,
    apexClassNamesIn, resolveEffectiveTestLevel, buildApexTestMap,
} from "../DeploymentPlanner";
import { buildPackageXml, AuditChangedFile, metadataTypeForPath } from "../AuditLog";
import { getPromotableEnvironments, getPublishEnvironment, getSourceRootFolder, getDeployTimeoutSeconds, canPromote, getBaseBranch, ResolvedEnvironment } from "../config";
import { getEffectiveRole } from "../RoleManager";
import { log } from "../Log";

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

/** The other half of a metadata file's on-disk pair — Foo.cls <-> Foo.cls-meta.xml. Used to keep the two always selected together, since deploying one without the other is either invalid or silently incomplete. */
function metaSiblingPath(filePath: string): string | null {
    if (filePath.endsWith("-meta.xml")) { return filePath.slice(0, -"-meta.xml".length) || null; }
    return `${filePath}-meta.xml`;
}

interface EnvViewModel {
    env:          ResolvedEnvironment;
    nextEnv?:     ResolvedEnvironment;
    prevEnv?:     ResolvedEnvironment;
    currentSha:   string | null;
    lastDeploy:   { sha: string; deployedAt: string } | null;
    groups:       StoryChangeGroup[];
    allFiles:     AuditChangedFile[];
    /** Path → the date of the most recent commit (within this env's pending range) that touched it — powers the "Date updated" sort. */
    fileDates:    Record<string, string>;
    diffVsNext:   AuditChangedFile[] | null;
    packageXml:   string;
    unmapped:     string[];
    canDeploy:    boolean;
    orgAliasSet:  boolean;
    /** Apex class basename → its detected test class basename (by naming convention), or null if none was found. Only covers non-test classes that are actually pending in this env. */
    apexTestMap:  Record<string, string | null>;
    /** Test class basename → its actual file path(s) (.cls + .cls-meta.xml) on this env's branch — used to fold a specified test's own files into the deploy even when they weren't otherwise selected. */
    apexTestFilePaths: Record<string, string[]>;
}

/** One-shot result of the last Validate/Deploy action, shown once as a banner then cleared. */
interface DeployOutcome {
    env:     string;
    kind:    "validatePassed" | "validateFailed" | "deploySucceeded" | "deployFailed";
    message: string;
    nextEnv?: { name: string; label: string };
    storyCount?: number;
}

export class DeploymentDashboardPanel {
    private static current: DeploymentDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    /**
     * Which single environment this panel is showing — the whole point of this panel is now
     * "you asked to deploy QA, so this is QA," not a general-purpose multi-tab surface. Every
     * caller (`sfDevops.openDeploymentDashboard`) already passes a specific env; there's no
     * "show me everything" entry point left, so binding to exactly one keeps the panel from
     * showing environments the user didn't ask about (and can't act on anyway, thanks to the
     * pipeline gate) alongside the one they did.
     */
    private _boundEnv: string;
    /**
     * Bumped at the start of every refresh() call. Since refresh() awaits fetchRemote() and
     * git reads before rendering, two overlapping refreshes (e.g. clicking DEV then UAT in
     * quick succession, or the background poller firing mid-refresh) can otherwise resolve
     * out of order — whichever finishes last wins the render, even if it was reading
     * _boundEnv for an env the user already navigated away from. Each refresh snapshots its
     * own token and only applies its render if no newer refresh has started meanwhile.
     */
    private _refreshToken = 0;
    private _lastOutcome?: DeployOutcome;
    /** Fingerprint (sorted file paths, joined) of the last selection that successfully Validated, per env — Deploy is locked until the CURRENT selection matches it exactly. Sticky across renders (unlike _lastOutcome), so it's not just a one-time click-time check: the button re-locks the moment the checked selection changes. */
    private _validatedSelections = new Map<string, string>();

    /** Opens (or rebinds, if already open) the dashboard to exactly one environment — see `_boundEnv`. */
    public static createOrShow(gitHelper: GitHelper, context: vscode.ExtensionContext, env: string) {
        if (DeploymentDashboardPanel.current) {
            DeploymentDashboardPanel.current._panel.reveal(vscode.ViewColumn.One);
            DeploymentDashboardPanel.current._boundEnv = env;
            DeploymentDashboardPanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "sfDevopsDeploymentDashboard",
            "SF DevOps Deployments",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DeploymentDashboardPanel.current = new DeploymentDashboardPanel(panel, gitHelper, context, env);
    }

    /** Refreshes the dashboard in place if it's currently open — used by the background poller. */
    public static refreshIfOpen() {
        DeploymentDashboardPanel.current?.refresh();
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _gitHelper: GitHelper,
        private readonly _extContext: vscode.ExtensionContext,
        env: string
    ) {
        this._panel = panel;
        this._boundEnv = env;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === "refresh") { await this.refresh(); }
            if (msg.command === "runAction") { await this._runAction(msg); }
            if (msg.command === "viewFileDiff") { await this._viewFileDiff(msg); }
            if (msg.command === "viewPendingFileDiff") { await this._viewPendingFileDiff(msg); }
            if (msg.command === "rollback") { await this._handleRollback(msg); }
            // The one remaining cross-env navigation — "deploy succeeded, N stories ready in
            // the next stage" — rebinds this same panel to that env rather than switching a
            // pre-rendered tab, so it stays true to "bound to exactly what was requested,"
            // even though that request now originates from inside the panel itself.
            if (msg.command === "rebind" && msg.env) {
                this._boundEnv = msg.env;
                await this.refresh();
            }
        }, null, this._disposables);

        this._panel.webview.html = this._loadingHtml();
        this.refresh();
    }

    public dispose() {
        DeploymentDashboardPanel.current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    /** Resolved fresh on every use — "Change Role" can update this at runtime, so it must never be cached. */
    private get _userRole(): string {
        return getEffectiveRole(this._extContext);
    }

    public async refresh() {
        const token = ++this._refreshToken;
        try {
            await this._gitHelper.fetchRemote();
            if (token !== this._refreshToken) { return; } // a newer refresh has since started — this one's result is stale
            // Dev (the publish env) is deployable here too — same tree/Validate/Deploy UI as
            // every other stage, tracked via the same recordDeployed/getDeployState this
            // dashboard already uses everywhere else. It never gates, and is never gated by,
            // anything (see the promotable-relative indexing in _runAction/_viewPendingFileDiff)
            // — it's just previously had NO way to see or trigger an actual deploy at all,
            // only "pushed to the dev branch," which is what made it unclear whether dev was
            // ever really deployed. Still need the full ordered list here even though only
            // ONE env gets rendered — that's how prevEnv/nextEnv (gating, diff-vs-next
            // preview) are found for whichever one is bound.
            const envs = [getPublishEnvironment(), ...getPromotableEnvironments()];
            const idx = envs.findIndex(e => e.name === this._boundEnv);
            if (idx === -1) {
                this._panel.webview.html = `<body style="padding:16px;color:#f48771;font-family:sans-serif">Unknown environment "${escapeHtml(this._boundEnv)}" — check sfDevops.environments.</body>`;
                return;
            }
            const prevEnv = idx > 0 ? envs[idx - 1] : undefined;
            const model = await this._buildViewModel(envs[idx], envs[idx + 1], prevEnv);
            if (token !== this._refreshToken) { return; } // stale by the time the view model finished building
            this._panel.title = `SF DevOps Deployments — ${model.env.label}`;
            this._panel.webview.html = this._renderHtml(model);
        } catch (err) {
            if (token !== this._refreshToken) { return; }
            this._panel.webview.html = `<body style="padding:16px;color:#f48771;font-family:sans-serif">Error: ${escapeHtml(String(err))}</body>`;
        }
    }

    private async _buildViewModel(env: ResolvedEnvironment, nextEnv?: ResolvedEnvironment, prevEnv?: ResolvedEnvironment): Promise<EnvViewModel> {
        const sourceRoot = getSourceRootFolder();
        const currentSha = await this._gitHelper.remoteHeadSha(env.branch);
        const lastDeploy  = await this._gitHelper.getDeployState(env.name);

        let groups: StoryChangeGroup[] = [];
        let allFiles: AuditChangedFile[] = [];
        const fileDates: Record<string, string> = {};

        // Baseline to diff "what's pending" from: the last thing this dashboard actually
        // deployed here, or — if it's never deployed here at all — the point where this
        // branch was cut from the previous stage (dev, which has no "previous stage" of its
        // own, uses the base branch feature branches are cut from instead). That merge-base
        // still gives a real, selectable file/story tree instead of an unselectable
        // "everything" blob; "Deploy ALL" below remains as an explicit fallback for whatever
        // this misses.
        const baselineBranch = prevEnv?.branch ?? getBaseBranch();
        const baseline = lastDeploy?.sha ?? await this._gitHelper.mergeBase(baselineBranch, env.branch);

        if (baseline && currentSha && baseline !== currentSha) {
            const commits: CommitInfo[] = await this._gitHelper.commitLogBetweenRaw(baseline, `origin/${env.branch}`);
            const filesByHash = new Map<string, AuditChangedFile[]>();
            for (const c of commits) {
                const filesForCommit = await this._gitHelper.filesInCommit(c.hash);
                filesByHash.set(c.hash, filesForCommit);
                // commits come back newest-first (git log's default order) — the first commit
                // touching a given path is its most recent, so only record a path's date once.
                for (const f of filesForCommit) {
                    if (!(f.path in fileDates)) { fileDates[f.path] = c.date; }
                }
            }
            groups = groupChangesByStory(commits, filesByHash);
            allFiles = dedupe(groups.flatMap(g => g.files));
        }

        let diffVsNext: AuditChangedFile[] | null = null;
        if (nextEnv) {
            try { diffVsNext = await this._gitHelper.diffNameStatusBetween(env.branch, nextEnv.branch, sourceRoot); }
            catch { diffVsNext = null; }
        }

        const { xml: packageXml, unmapped } = buildPackageXml(allFiles);

        // Auto-pick a test class per pending Apex class, by the same filename convention
        // the Code Coverage panel already uses (<Class>Test, <Class>_Test, Test<Class>,
        // <Class>Tests) — checked against what actually exists on this env's branch, not
        // just what's in the pending selection (a story can add a class whose test already
        // lived on this branch from an earlier promotion). Also keeps each detected test
        // class's own file paths (apexTestFilePaths) — RunSpecifiedTests requires the named
        // test class to actually be IN the deployment package (or already exist in the
        // target org); on a never-deployed-before env it won't exist there yet, and if the
        // test file itself wasn't part of the pending selection either, the CLI fails with
        // an opaque "tests specified must be in the deployment package" error. _runAction
        // uses this map to fold the test file(s) into the deploy even when they weren't
        // otherwise selected, so picking "auto-detected tests" can never produce a deploy
        // that's missing the very test it asked for.
        const pendingApexClasses = apexClassNamesIn(allFiles);
        const { apexTestMap, apexTestFilePaths } = pendingApexClasses.length > 0
            ? buildApexTestMap(await this._gitHelper.listFilesAtRef(env.branch, sourceRoot), pendingApexClasses)
            : { apexTestMap: {}, apexTestFilePaths: {} };

        return {
            env, nextEnv, prevEnv, currentSha, lastDeploy, groups, allFiles, fileDates, diffVsNext, packageXml, unmapped, apexTestMap, apexTestFilePaths,
            canDeploy:   canPromote(this._userRole, env),
            orgAliasSet: Boolean(env.orgAlias),
        };
    }

    /** Runs one Validate or Deploy step against an already-resolved file selection, and records the outcome (deploy-state + audit log) — shared by a single manual action and each half of an auto-deploy chain. */
    private async _executeStep(
        env: ResolvedEnvironment,
        mode: DeployMode,
        selection: DeploySelection,
        files: AuditChangedFile[],
        summary: string,
        testLevel: string,
        tests?: string[],
        progress?: vscode.Progress<{ message?: string }>
    ): Promise<DeployResult> {
        const { xml: packageXml, unmapped } = buildPackageXml(files);

        const result = await runDeploy(
            this._gitHelper.getWorkspaceRoot(),
            getSourceRootFolder(),
            selection.mode === "all" ? [] : files.map(f => f.path),
            env.orgAlias ?? "",
            testLevel,
            getDeployTimeoutSeconds(),
            mode,
            tests,
            status => progress?.report({ message: status })
        );

        if (result.success && mode === "deploy") {
            const sha = await this._gitHelper.remoteHeadSha(env.branch);
            if (sha) { await this._gitHelper.recordDeployed(env.name, sha, { numberComponentsDeployed: result.numberComponentsDeployed }); }
        }

        await this._gitHelper.appendAudit({
            operation:  mode === "deploy" ? "deploy" : "deployValidate",
            targetEnv:  env.name,
            outcome:    result.success ? "success" : "failure",
            summary:    `${summary} — ${result.success ? "succeeded" : (result.error ?? "failed")}`,
            details:    {
                changedFiles: files, packageXml, unmappedFiles: unmapped,
                deployId: result.deployId, componentFailures: result.componentFailures,
                selectionMode: selection.mode, error: result.error,
                testLevel, tests,
            },
        });

        return result;
    }

    private async _runAction(msg: any) {
        // Dev (the publish env) is deployable from here too, but it's not in the promotable
        // pipeline — it never gates a later env and is never gated itself (its "previous
        // stage" would be the base branch feature branches are cut from, which has no deploy
        // step at all). Every actual promotable env keeps its existing promotable-relative
        // indexing and gate untouched.
        const publishEnv = getPublishEnvironment();
        const promotable = getPromotableEnvironments();
        const env = [publishEnv, ...promotable].find(e => e.name === msg.env);
        if (!env) { return; }

        // A real Validate/Deploy can take well past a few seconds (branch checkout, a real
        // Salesforce check-only or real deploy, now polled every few seconds rather than one
        // blocking call) — with nothing in the webview itself disabling buttons while that
        // runs, a second click (Deploy again, or Validate while Deploy is still going) would
        // otherwise race a second `git checkout -B` against the same working tree the first
        // one is still using — exactly the class of bug already fixed for Promote/Resume/
        // Publish. Refuse the second click instead of letting that race happen.
        const lockKey = `dashboard:${env.name}`;
        if (!this._gitHelper.tryBeginOperation(lockKey)) {
            vscode.window.showWarningMessage(`Already ${msg.actionMode === "deploy" ? "deploying to" : "validating against"} ${env.label} — give it a moment to finish before clicking again.`);
            return;
        }

        try {

        const isDev = env.name === publishEnv.name;
        const promIdx = promotable.findIndex(e => e.name === env.name);

        const requestedMode: DeployMode = msg.actionMode === "deploy" ? "deploy" : "validate";
        const selection: DeploySelection = { mode: msg.selectionMode, storyIds: msg.storyIds, files: msg.files };

        // Hard server-side gate — never trust the client's checkbox for Prod, regardless of
        // what the (disabled-in-UI) checkbox somehow sends. Prod always needs a manual Deploy click.
        const autoDeployRequested = Boolean(msg.autoDeployOnSuccess) && !env.isProd;

        const nextEnv = isDev ? promotable[0] : promotable[promIdx + 1];
        const prevEnv = isDev ? undefined : (promIdx > 0 ? promotable[promIdx - 1] : publishEnv);

        // Hard gate: env N-1 must actually be deployed before env N can be Validated/Deployed
        // — skipped for dev (nothing before it) and for the first promotable env (its
        // "previous stage" is the publish env, which has no deploy step). Same enforcement as
        // the Promote picker's gate, so acting out of order isn't possible from either entry point.
        if (!isDev && promIdx > 0) {
            const gap = await this._gitHelper.checkPrevEnvDeployed(prevEnv!);
            if (gap.blocked) {
                vscode.window.showWarningMessage(gap.reason!);
                return;
            }
        }

        const model = await this._buildViewModel(env, nextEnv, prevEnv);
        let { files, summary } = resolveSelection(selection, model.groups, model.allFiles);

        // Belt-and-suspenders, same as the auto-test-file folding below: a "files" selection
        // is never trusted to have already paired each component with its own -meta.xml (the
        // client does this too, but a selection could in principle arrive without it) — fold
        // in any sibling that's actually pending here but wasn't in the selection.
        if (selection.mode === "files") {
            const present = new Set(files.map(f => f.path));
            const pendingByPath = new Map(model.allFiles.map(f => [f.path, f]));
            const extraMeta: AuditChangedFile[] = [];
            for (const f of files) {
                const sibling = metaSiblingPath(f.path);
                if (sibling && !present.has(sibling)) {
                    const siblingFile = pendingByPath.get(sibling);
                    if (siblingFile) { present.add(sibling); extraMeta.push(siblingFile); }
                }
            }
            if (extraMeta.length > 0) { files = [...files, ...extraMeta]; }
        }

        // Which tests actually run is recomputed here from the FINAL resolved file list, not
        // trusted from the client — same "never trust the client for what actually executes"
        // principle as the deploy-lock/prod gates above. "auto" is the default whenever the
        // client doesn't say otherwise.
        const testMode: "auto" | "all" = msg.testMode === "all" ? "all" : "auto";
        const { testLevel, tests } = resolveEffectiveTestLevel(env.deployTestLevel, testMode, apexClassNamesIn(files), model.apexTestMap);

        // RunSpecifiedTests requires each named test class to actually be part of the
        // deployment package (or already exist in the target org) — on a never-deployed
        // env, or when the test file simply wasn't in the pending selection, it might be
        // neither, and the CLI fails with an opaque "tests specified must be in the
        // deployment package" error. Fold each detected test's own file(s) into what's
        // actually being deployed so picking "auto-detected tests" can never produce a
        // deploy that's missing the test it just asked for. "all" mode already deploys
        // everything (sourceDirs stays empty), so there's nothing to fold in there.
        if (testLevel === "RunSpecifiedTests" && selection.mode !== "all" && tests?.length) {
            const present = new Set(files.map(f => f.path));
            const extra: AuditChangedFile[] = [];
            for (const testName of tests) {
                for (const p of model.apexTestFilePaths[testName] ?? []) {
                    if (!present.has(p)) { present.add(p); extra.push({ path: p, change: "modified" }); }
                }
            }
            if (extra.length > 0) { files = [...files, ...extra]; }
        }

        // A deleted file doesn't exist on disk after the checkout below — passing it as
        // --source-dir crashes the CLI outright with "File or folder not found" (this is the
        // same gap buildPackageXml's manifest preview already works around — "real deletions
        // belong in destructiveChanges.xml, not here" — that fix never reached what's actually
        // sent to the CLI). Not deployable this way yet; drop them from the selection and say
        // so clearly instead of crashing or silently leaving them undeleted with no explanation.
        // "all" mode deploys the whole source root with no explicit file list, so this doesn't
        // apply there.
        if (selection.mode !== "all") {
            const deletedFiles = files.filter(f => f.change === "deleted");
            if (deletedFiles.length > 0) {
                files = files.filter(f => f.change !== "deleted");
                vscode.window.showWarningMessage(
                    `${deletedFiles.length} deleted file(s) can't be included in this ${requestedMode === "deploy" ? "deploy" : "validate"} yet ` +
                    `(${deletedFiles.slice(0, 3).map(f => f.path.split("/").pop()).join(", ")}${deletedFiles.length > 3 ? ", …" : ""}) — ` +
                    `delete them manually in ${env.label} for now.`
                );
            }
        }

        // An empty non-"all" selection must never silently fall through to deploying the
        // entire source root (DeploymentEngine treats an empty sourceDirs array as "no
        // restriction") — reject it explicitly instead.
        if (selection.mode !== "all" && files.length === 0) {
            vscode.window.showWarningMessage("No files selected — check at least one file, or use Deploy ALL.");
            return;
        }

        // Hard server-side gate — a standalone manual Deploy is locked until Validate has
        // actually passed for EXACTLY this selection (never trust the client button's enabled
        // state alone). The auto-deploy chain below is exempt: it always runs its own Validate
        // immediately beforehand in the same request, so it's inherently already satisfied.
        if (requestedMode === "deploy") {
            const fp = fingerprintFiles(files);
            if (this._validatedSelections.get(env.name) !== fp) {
                vscode.window.showWarningMessage(`Run Validate on this exact selection for ${env.label} first — Deploy stays locked until it passes for what's currently checked.`);
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `${msg.selectionMode === "all" ? "Deploy ALL pending changes" : "Deploy the selected changes"} to ${env.label} (${env.orgAlias})?\n\nThis runs a real Salesforce deployment.`,
                { modal: true },
                "Yes, deploy"
            );
            if (!confirm) { return; }
        }

        let stashLabel: string | null = null;
        if (await this._gitHelper.hasUncommittedChanges()) {
            stashLabel = await warnUncommittedChanges(
                this._gitHelper,
                "Commit or stash your local changes before deploying — this checks out a fresh copy of the environment branch from origin, which would collide with them. Note this deploy would never have included them anyway: it always deploys origin's pushed content, never local edits.",
                { offerStash: true }
            );
            if (!stashLabel) { return; }
        }

        const originalBranch = await this._gitHelper.currentBranch();

        // Captured inside the progress callback, acted on AFTER it — see below for why.
        // A plain `let` narrows to `null` at the read site below (TS can't see the closure
        // actually assigns it), so this uses a wrapper object instead of relying on that.
        const cleanupPrompt: { value: { env: ResolvedEnvironment; storyIds: string[] } | null } = { value: null };

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `${requestedMode === "deploy" ? "Deploying" : "Validating"} against ${env.label}...`, cancellable: false },
            async (progress) => {
                try {
                    progress.report({ message: `Switching local checkout to origin/${env.branch} and pulling latest...` });
                    await this._gitHelper.createLocalBranchFrom(env.branch, env.branch);

                    const first = await this._executeStep(env, requestedMode, selection, files, summary, testLevel, tests, progress);

                    if (requestedMode === "validate" && first.success) {
                        this._validatedSelections.set(env.name, fingerprintFiles(files));
                    }

                    if (requestedMode === "validate" && first.success && autoDeployRequested) {
                        log(`Validate passed — auto-deploying to ${env.label} (auto-deploy enabled)…`);
                        const second = await this._executeStep(env, "deploy", selection, files, summary, testLevel, tests, progress);
                        if (second.success) { this._validatedSelections.delete(env.name); }
                        this._lastOutcome = second.success
                            ? {
                                env: env.name, kind: "deploySucceeded", message: `Validated and deployed — ${summary}.`,
                                nextEnv: nextEnv ? { name: nextEnv.name, label: nextEnv.label } : undefined,
                                storyCount: countTouchedGroups(model.groups, files),
                              }
                            : { env: env.name, kind: "deployFailed", message: second.error ?? "Auto-deploy failed after a successful validate." };
                        if (second.success) {
                            vscode.window.showInformationMessage(`✅ Validated and auto-deployed to ${env.label} — ${summary}.`);
                            cleanupPrompt.value = { env, storyIds: touchedStoryIds(model.groups, files) };
                        } else {
                            vscode.window.showErrorMessage(`❌ Validate passed but auto-deploy to ${env.label} failed: ${second.error ?? "see the audit trail"}.`);
                        }
                    } else if (requestedMode === "validate") {
                        this._lastOutcome = first.success
                            ? { env: env.name, kind: "validatePassed", message: `Validate passed (${testLevelSummary(testLevel, tests)}) — Deploy is now unlocked for this selection.` }
                            : { env: env.name, kind: "validateFailed", message: first.error ?? "Validation failed." };
                        if (first.success) {
                            vscode.window.showInformationMessage(`✅ Validated against ${env.label} — ${summary}.`);
                        } else {
                            vscode.window.showErrorMessage(`❌ Validation against ${env.label} failed: ${first.error ?? "see component failures in the audit trail"}.`);
                        }
                    } else {
                        if (first.success) { this._validatedSelections.delete(env.name); }
                        this._lastOutcome = first.success
                            ? {
                                env: env.name, kind: "deploySucceeded", message: `Deployed — ${summary} (${testLevelSummary(testLevel, tests)}).`,
                                nextEnv: nextEnv ? { name: nextEnv.name, label: nextEnv.label } : undefined,
                                storyCount: countTouchedGroups(model.groups, files),
                              }
                            : { env: env.name, kind: "deployFailed", message: first.error ?? "Deploy failed." };
                        if (first.success) {
                            vscode.window.showInformationMessage(`✅ Deployed against ${env.label} — ${summary}.`);
                            cleanupPrompt.value = { env, storyIds: touchedStoryIds(model.groups, files) };
                        } else {
                            vscode.window.showErrorMessage(`❌ Deploy against ${env.label} failed: ${first.error ?? "see component failures in the audit trail"}.`);
                        }
                    }
                } catch (err) {
                    await this._gitHelper.appendAudit({
                        operation: requestedMode === "deploy" ? "deploy" : "deployValidate",
                        targetEnv: env.name, outcome: "failure",
                        summary: `${requestedMode === "deploy" ? "Deploy" : "Validation"} failed`,
                        details: { error: String(err) },
                    });
                    this._lastOutcome = {
                        env: env.name, kind: requestedMode === "deploy" ? "deployFailed" : "validateFailed",
                        message: String(err),
                    };
                    vscode.window.showErrorMessage(`${requestedMode === "deploy" ? "Deploy" : "Validation"} failed: ${err}`);
                } finally {
                    if (originalBranch) { await this._gitHelper.checkoutBranch(originalBranch).catch(() => {}); }
                    if (stashLabel) {
                        const restore = await this._gitHelper.restoreStash(stashLabel);
                        if (restore.status === "conflict") {
                            vscode.window.showWarningMessage(
                                `Your stashed changes are safe but conflicted while restoring — resolve the conflict markers now showing in your files (Source Control view), then run "git stash drop" to finish (stash: ${restore.ref}).`
                            );
                        }
                    }
                    await this.refresh();
                }
            }
        );

        // Deliberately OUTSIDE the progress notification above, not inside it — this prompt
        // has its own action buttons ("Yes, delete" / "No") and awaiting it from inside the
        // notification's callback left the "Deploying/Validating against X..." toast visibly
        // stuck open (still showing its last, already-final status) for as long as this
        // separate, easy-to-miss prompt sat unanswered — looking exactly like a hang even
        // though the actual deploy had already finished. Now the deploy notification closes
        // the instant the deploy itself is done, and this asks its own question afterward.
        if (cleanupPrompt.value) {
            await this._promptCleanupPromotionBranches(cleanupPrompt.value.env, cleanupPrompt.value.storyIds);
        }
        } finally {
            this._gitHelper.endOperation(lockKey);
        }
    }

    /**
     * Stage 4's "Clean Up" — asks once, right after a successful deploy, whether to delete
     * the promotion branch(es) for whichever stories this deploy actually touched. Never
     * silent/automatic (deleting a branch is real): a "No" or dismiss leaves everything
     * exactly as it was. Dev (the publish env) has no promotion-branch concept, so this is
     * a no-op there.
     */
    private async _promptCleanupPromotionBranches(env: ResolvedEnvironment, storyIds: string[]): Promise<void> {
        if (env.name === getPublishEnvironment().name || storyIds.length === 0) { return; }
        const branches = storyIds.map(id => ({ id, branch: this._gitHelper.promoBranchName(id, env.name, "promote") }));
        const existing: typeof branches = [];
        for (const b of branches) {
            if (await this._gitHelper.remoteBranchExists(b.branch)) { existing.push(b); }
        }
        if (existing.length === 0) { return; }

        const list = existing.map(b => b.branch).join(", ");
        const choice = await vscode.window.showInformationMessage(
            `${env.label} is deployed — delete the promotion branch${existing.length > 1 ? "es" : ""} now that ${existing.length > 1 ? "they're" : "it's"} done?\n\n${list}`,
            "Yes, delete", "No"
        );
        if (choice !== "Yes, delete") { return; }

        for (const b of existing) {
            await this._gitHelper.deletePromotionBranch(b.id, env.name);
            await this._gitHelper.appendAudit({
                operation: "promote", storyId: b.id, targetEnv: env.name, branch: b.branch, outcome: "success",
                summary: `${b.branch} deleted after a successful deploy to ${env.label}`,
            });
        }
        vscode.window.showInformationMessage(`🧹 Deleted ${existing.length} promotion branch${existing.length > 1 ? "es" : ""}.`);
    }

    /**
     * Rollback to last-deployed SHA: checks out that exact commit locally, runs a full
     * "Deploy ALL" against the env's org to restore it to the known-good state, then
     * restores the working tree and cleans up the temp branch.
     */
    private async _handleRollback(msg: { env: string }) {
        const publishEnv = getPublishEnvironment();
        const promotable = getPromotableEnvironments();
        const env = [publishEnv, ...promotable].find(e => e.name === msg.env);
        if (!env) { return; }

        if (!canPromote(this._userRole, env)) {
            vscode.window.showWarningMessage(`Your role can't deploy to ${env.label}.`);
            return;
        }

        const lastDeploy = await this._gitHelper.getDeployState(env.name);
        if (!lastDeploy) {
            vscode.window.showWarningMessage("No recorded deploy to roll back to.");
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Roll back ${env.label} (${env.orgAlias}) to the state at commit ${lastDeploy.sha.slice(0, 8)}?\n\n` +
            `This redeploys the ENTIRE source folder at that snapshot to the org. Only use this to undo a bad promotion.`,
            { modal: true },
            "Yes, roll back"
        );
        if (!confirm) { return; }

        const lockKey = `dashboard:${env.name}`;
        if (!this._gitHelper.tryBeginOperation(lockKey)) {
            vscode.window.showWarningMessage(`Already deploying to ${env.label} — wait for it to finish.`);
            return;
        }

        let stashLabel: string | null = null;
        if (await this._gitHelper.hasUncommittedChanges()) {
            stashLabel = await warnUncommittedChanges(
                this._gitHelper,
                "Commit or stash your local changes before rolling back — this checks out a specific commit SHA.",
                { offerStash: true }
            );
            if (!stashLabel) { this._gitHelper.endOperation(lockKey); return; }
        }

        const originalBranch = await this._gitHelper.currentBranch();
        const tempBranch = `sf-devops-rollback/${env.name}`;

        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Rolling back ${env.label} to ${lastDeploy.sha.slice(0, 8)}…`, cancellable: false },
                async (progress) => {
                    progress.report({ message: `Checking out snapshot ${lastDeploy.sha.slice(0, 8)}…` });
                    await this._gitHelper.createTempBranchAtSha(lastDeploy.sha, tempBranch);

                    const result = await this._executeStep(
                        env, "deploy",
                        { mode: "all", storyIds: [], files: [] },
                        [],
                        `Rollback ${env.label} to ${lastDeploy.sha.slice(0, 8)}`,
                        "NoTestRun",
                        undefined,
                        progress
                    );

                    if (result.success) {
                        this._lastOutcome = { env: env.name, kind: "deploySucceeded", message: `✅ Rolled back ${env.label} to ${lastDeploy.sha.slice(0, 8)}` };
                    } else {
                        this._lastOutcome = { env: env.name, kind: "deployFailed", message: `❌ Rollback failed: ${result.error ?? "unknown error"}` };
                    }
                }
            );
        } finally {
            // Always restore the working tree, regardless of deploy outcome.
            if (originalBranch) {
                await this._gitHelper.checkoutBranch(originalBranch).catch(() => {});
            }
            await this._gitHelper.deleteTempBranch(tempBranch);
            this._gitHelper.endOperation(lockKey);
            if (stashLabel) { await this._gitHelper.restoreStash(stashLabel).catch(() => {}); }
            await this.refresh();
        }
    }

    /** Diff between two environment branches — used by the "diff vs next env" preview list. */
    private async _viewFileDiff(msg: { targetEnv: string; beforeRef: string; beforeLabel: string; afterRef: string; afterLabel: string; path: string }) {
        const before = await this._gitHelper.fileContentAtRef(msg.beforeRef, msg.path);
        const after  = await this._gitHelper.fileContentAtRef(msg.afterRef, msg.path);
        this._panel.webview.postMessage({
            command: "fileDiffResult", targetEnv: msg.targetEnv, path: msg.path,
            beforeLabel: msg.beforeLabel, afterLabel: msg.afterLabel,
            before, after, // null means the file doesn't exist at that ref — the client renders that as a whole-file add/delete, not literal text
        });
    }

    /** Diff between what's actually deployed (or the previous stage, if never deployed) and this environment's pending branch content — used by clicking a file row in the left tree. A small targeted lookup, not a full _buildViewModel() rebuild. */
    private async _viewPendingFileDiff(msg: { env: string; path: string }) {
        const publishEnv = getPublishEnvironment();
        const promotable = getPromotableEnvironments();
        const env = [publishEnv, ...promotable].find(e => e.name === msg.env);
        if (!env) { return; }
        const isDev = env.name === publishEnv.name;
        const promIdx = promotable.findIndex(e => e.name === env.name);
        const prevLabel  = isDev ? getBaseBranch() : (promIdx > 0 ? promotable[promIdx - 1].label : publishEnv.label);
        const prevBranch = isDev ? getBaseBranch() : (promIdx > 0 ? promotable[promIdx - 1].branch : publishEnv.branch);
        const lastDeploy = await this._gitHelper.getDeployState(env.name);

        const before = lastDeploy
            ? await this._gitHelper.fileContentAtSha(lastDeploy.sha, msg.path)
            : await this._gitHelper.fileContentAtRef(prevBranch, msg.path);
        const after = await this._gitHelper.fileContentAtRef(env.branch, msg.path);

        this._panel.webview.postMessage({
            command: "fileDiffResult", targetEnv: env.name, path: msg.path,
            beforeLabel: lastDeploy ? `Last deployed to ${env.label} (${lastDeploy.sha.slice(0, 7)})` : `${prevLabel} (current)`,
            afterLabel: `${env.label} (pending)`,
            before, after,
        });
    }

    private _loadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">Loading deployment status…</body></html>`;
    }

    private _renderHtml(model: EnvViewModel): string {
        const notice = model.groups.length > 0
            ? `<div class="notice">⚠ ${model.groups.length} story/PR group(s), ${model.allFiles.length} file(s) pending deployment</div>`
            : (model.lastDeploy === null && model.currentSha)
            ? `<div class="notice muted">ℹ Never deployed from this dashboard yet — nothing pending to bootstrap from</div>`
            : "";

        const envPane = this._renderEnvPane(model);
        this._lastOutcome = undefined; // one-shot: shown once, then cleared

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { --bg:#1e1e1e; --fg:#e0e0e0; --card:#252526; --border:#3c3c3c; --muted:#999; --accent:#4fc3f7; --err:#ff6b6b; --ok:#7cd992; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#ffffff; --fg:#1a1a1a; --card:#f5f5f5; --border:#ddd; --muted:#666; --accent:#0078d4; --err:#c62828; --ok:#1b6b2f; }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 0 24px 60px; max-width: 1500px; }
  h1 { font-size: 20px; margin: 0; padding: 20px 0 4px; }
  h2 { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .notice { background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; font-size: 13px; }
  .notice.muted { border-left-color: var(--muted); color: var(--muted); }

  .pane { display: block; }
  section.env { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 12px; }

  .outcome { border-radius: 6px; padding: 8px 12px; margin: 8px 0; font-size: 13px; border: 1px solid var(--border); }
  .outcome a { color: inherit; font-weight: 600; text-decoration: underline; margin-left: 4px; cursor: pointer; }
  .outcome-validatePassed, .outcome-deploySucceeded { background: #2e7d3222; border-color: var(--ok); color: var(--ok); }
  .outcome-validateFailed, .outcome-deployFailed { background: #c6282822; border-color: var(--err); color: var(--err); }

  .split { display: flex; gap: 16px; margin-top: 12px; }
  .split-left { flex: 0 0 35%; min-width: 260px; max-height: 62vh; overflow-y: auto; padding-right: 4px; }
  .split-right { flex: 1 1 65%; min-width: 320px; max-height: 62vh; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 8px; }

  .story-filter { width: 100%; font-size: 12px; padding: 5px 6px; margin-bottom: 8px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; }
  .select-row { font-size: 11px; margin-bottom: 6px; }
  .select-row a { color: var(--accent); cursor: pointer; text-decoration: none; }
  .select-row a:hover { text-decoration: underline; }
  .tree-controls { display: flex; align-items: center; justify-content: space-between; font-size: 11px; margin-bottom: 8px; color: var(--muted); gap: 8px; }
  .tree-controls label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .sort-select { font-size: 11px; padding: 2px 4px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 3px; }
  .tree.hide-meta .meta-file { display: none; }
  .selection-summary { font-size: 11px; color: var(--muted); margin-bottom: 8px; }

  .type-group { margin-bottom: 6px; }
  .type-group summary { cursor: pointer; font-weight: 600; font-size: 12px; padding: 3px 0; }
  ul.files { list-style: none; margin: 4px 0 4px 8px; padding: 0; font-size: 12px; }
  ul.files li { padding: 2px 0; display: flex; align-items: center; gap: 6px; }
  ul.files li.clickable { cursor: pointer; }
  ul.files li.clickable:hover { color: var(--accent); }
  .tree-row input[type=checkbox] { flex-shrink: 0; }
  .file-path { flex: 1; word-break: break-all; }
  .file-path.clickable { cursor: pointer; }
  .file-path.clickable:hover { color: var(--accent); text-decoration: underline; }
  .story-badge { font-size: 10px; color: var(--muted); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; flex-shrink: 0; }

  .change { font-size: 10px; text-transform: uppercase; border-radius: 3px; padding: 1px 5px; flex-shrink: 0; opacity: 0.8; }
  .change.added { background: #2e7d3222; color: #4caf50; }
  .change.modified { background: #f9a82522; color: #ffa726; }
  .change.deleted { background: #c6282822; color: var(--err); }

  .group { border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; }
  .group-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .shared { font-size: 11px; color: var(--err); margin-left: 6px; font-weight: normal; }

  .busy-bar {
    margin-top: 14px; padding: 8px 12px; border-radius: 6px; font-size: 12.5px;
    background: color-mix(in srgb, var(--accent) 12%, transparent); border: 1px solid var(--accent);
    color: var(--fg); display: flex; align-items: center; gap: 8px;
  }
  .busy-bar .spin { display: inline-block; animation: sf-devops-spin 1s linear infinite; }
  @keyframes sf-devops-spin { to { transform: rotate(360deg); } }
  .deploy-row { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
  .auto-deploy-label { font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .auto-deploy-label .meta { margin: 0; }

  .tests-panel { border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin-top: 14px; background: color-mix(in srgb, var(--accent) 6%, var(--card)); }
  .tests-panel-head { font-weight: 600; font-size: 12.5px; margin-bottom: 6px; }
  .tests-mode-row { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; margin-bottom: 6px; }
  .tests-mode-row label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .tests-detail { font-size: 12px; color: var(--muted); }
  .tests-detail .test-chip { display: inline-block; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; margin: 2px 4px 2px 0; font-size: 11px; color: var(--ok); }
  .tests-detail .test-missing { color: var(--err); }

  .actions { display: flex; gap: 8px; margin-top: 12px; }
  .btn { font-size: 12px; padding: 7px 14px; border-radius: 6px; border: none; cursor: pointer; }
  .btn-primary { background: #0078d4; color: white; }
  .btn-primary.btn-highlight { box-shadow: 0 0 0 2px var(--ok); }
  .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--fg); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .warn { color: #ffab70; font-size: 12px; margin-top: 8px; }
  details.diff { margin-top: 14px; }
  details.diff summary { cursor: pointer; font-weight: 600; }
  pre.manifest { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; overflow-x: auto; font-size: 11px; max-height: 220px; }

  .diffTitle { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
  .diffMeta { margin-bottom: 6px; }
  .diffStat { font-size: 12px; margin: 2px 0 10px; }
  .diffStat .plus { color: var(--ok); }
  .diffStat .minus { color: var(--err); }
  .diffBody { font-family: var(--vscode-editor-font-family, "SF Mono", Consolas, monospace); font-size: 12px; }
  .diffline { display: flex; white-space: pre; }
  .diffline .gutter { flex: 0 0 88px; text-align: right; padding: 0 10px; color: var(--muted); opacity: 0.7; user-select: none; border-right: 1px solid var(--border); }
  .diffline .marker { flex: 0 0 18px; text-align: center; opacity: 0.8; user-select: none; }
  .diffline .txt { flex: 1; padding-right: 12px; overflow-x: visible; }
  .diffline.diff-add { background: #2e7d3222; }
  .diffline.diff-add .marker, .diffline.diff-add .txt { color: #4caf50; }
  .diffline.diff-del { background: #c6282822; }
  .diffline.diff-del .marker, .diffline.diff-del .txt { color: var(--err); }
  .diffline.diff-same .txt { color: var(--fg); opacity: 0.85; }
  .diffline.diff-context { justify-content: center; color: var(--muted); padding: 2px 0; font-size: 11px; }
</style>
</head>
<body>
<h1>SF DevOps Deployments — ${escapeHtml(model.env.label)}</h1>
<div class="sub">Everything merged into ${escapeHtml(model.env.label)}'s branch, not yet deployed by this extension. Deploys and validations run <code>sf project deploy</code> directly — no external CI involved.</div>

${notice}

${envPane}

<script>
  const vscode = acquireVsCodeApi();

  function send(command, payload) { vscode.postMessage(Object.assign({ command }, payload)); }
  function refresh() { send('refresh'); }
  function rebind(env) { send('rebind', { env: env }); }

  // A component's -meta.xml is deployed together with it always — mirror the checkbox
  // state onto its sibling so you never have to remember to check both (or worse, check
  // just the meta file and forget the component it belongs to).
  function metaSiblingPath(path) {
    return path.endsWith('-meta.xml') ? path.slice(0, -'-meta.xml'.length) : (path + '-meta.xml');
  }

  function toggleFile(env, cb) {
    var sibling = metaSiblingPath(cb.value);
    var boxes = document.querySelectorAll('.file-check[data-env="' + env + '"]');
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].value === sibling) { boxes[i].checked = cb.checked; break; }
    }
    recomputeSelection(env);
  }

  // Meta files stay in the DOM (and keep whatever checked state they were given above) even
  // while hidden — this only controls whether their row is shown, never whether they're
  // included in the actual selection sent to the server.
  function toggleShowMeta(env) {
    var tree = document.getElementById('tree-' + env);
    var cb = document.getElementById('showMeta-' + env);
    if (tree && cb) { tree.classList.toggle('hide-meta', !cb.checked); }
  }

  function applySort(env) {
    var sel = document.querySelector('.sort-select[data-env="' + env + '"]');
    var mode = sel ? sel.value : 'name';
    document.querySelectorAll('.type-group[data-env="' + env + '"] ul.files').forEach(function (ul) {
      var rows = Array.prototype.slice.call(ul.querySelectorAll('.tree-row'));
      rows.sort(function (a, b) {
        if (mode === 'date') {
          var da = Date.parse(a.dataset.date || '') || 0;
          var db = Date.parse(b.dataset.date || '') || 0;
          if (da !== db) { return db - da; } // most recently updated first
        }
        return (a.dataset.name || '').localeCompare(b.dataset.name || '');
      });
      rows.forEach(function (row) { ul.appendChild(row); });
    });
  }

  function currentFingerprint(env) {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.file-check[data-env="' + env + '"]:checked'));
    return boxes.map(function (b) { return b.value; }).sort().join('|');
  }

  // Deploy stays locked (regardless of org/role) until the CURRENTLY checked selection is
  // byte-for-byte what Validate last passed for that env — re-evaluated on every checkbox
  // change, so unchecking even one file re-locks it immediately. The server enforces this too
  // (never trust a client-side disabled attribute alone) — this is what keeps the UI honest.
  // Returns whether it's unlocked, so recomputeSelection can tell the user what to do next.
  function updateDeployButtonState(env) {
    var pane = document.querySelector('.pane[data-env="' + env + '"]');
    var btn = document.getElementById('deployBtn-' + env);
    if (!pane || !btn) { return false; }
    var hasValidated = pane.dataset.hasValidated === '1';
    var matches = hasValidated && currentFingerprint(env) === (pane.dataset.validatedFp || '');
    btn.disabled = btn.dataset.hardDisabled === '1' || !matches;
    btn.title = matches ? '' : 'Run Validate on this exact selection first';
    btn.classList.toggle('btn-highlight', matches && btn.dataset.hardDisabled !== '1');
    return matches;
  }

  function recomputeSelection(env) {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.file-check[data-env="' + env + '"]:checked'));
    var stories = {};
    boxes.forEach(function (b) {
      var row = b.closest('.tree-row');
      var s = row ? row.dataset.stories : '';
      (s ? s.split(',') : []).forEach(function (id) { if (id) { stories[id] = true; } });
    });
    var ready = updateDeployButtonState(env); // must run before building the summary text below
    var summaryEl = document.getElementById('selSummary-' + env);
    if (summaryEl) {
      if (boxes.length === 0) {
        summaryEl.textContent = 'No files selected.';
      } else {
        var base = boxes.length + ' file(s) selected across ' + Object.keys(stories).length + ' story/PR group(s).';
        summaryEl.textContent = base + (ready ? ' Ready — click Deploy.' : ' Next: click Validate.');
      }
    }
    updateTestsPanel(env);
  }

  function currentTestMode(env) {
    var checked = document.querySelector('input[name="testMode-' + env + '"]:checked');
    return checked ? checked.value : 'auto';
  }

  // Apex class names actually in play for this action: whatever's checked in the tree, or —
  // in bootstrap mode, where there's nothing to check — every Apex class this env has pending.
  function selectedApexClasses(env) {
    var pane = document.querySelector('.pane[data-env="' + env + '"]');
    var testMap = pane ? JSON.parse(pane.dataset.apexTestMap || '{}') : {};
    var allBoxes = document.querySelectorAll('.file-check[data-env="' + env + '"]');
    var names;
    if (allBoxes.length === 0) {
      names = Object.keys(testMap);
    } else {
      names = Array.prototype.slice.call(allBoxes).filter(function (b) { return b.checked; })
        .map(function (b) { var row = b.closest('.tree-row'); return row ? row.dataset.apexName : null; })
        .filter(Boolean);
    }
    return { names: Array.from(new Set(names)), testMap: testMap };
  }

  // Live preview of exactly which tests THIS action will run — the server recomputes this
  // independently before actually deploying (never trusts this panel), but showing it here
  // means there are no surprises about what's about to execute.
  function updateTestsPanel(env) {
    var detail = document.getElementById('testsDetail-' + env);
    if (!detail) { return; }
    var mode = currentTestMode(env);
    if (mode === 'all') {
      detail.innerHTML = 'Every test in the org will run — slower, but no coverage gaps.';
      return;
    }
    var sel = selectedApexClasses(env);
    if (sel.names.length === 0) {
      detail.innerHTML = 'No Apex classes selected — the environment\\'s default test level applies.';
      return;
    }
    var found = [], missing = [];
    sel.names.forEach(function (name) {
      var t = sel.testMap[name];
      if (t) { found.push(t); } else { missing.push(name); }
    });
    found = Array.from(new Set(found));
    var html = '';
    if (found.length) {
      html += found.length + ' test class(es) will run: ' + found.map(function (t) { return '<span class="test-chip">' + escapeHtmlJs(t) + '</span>'; }).join('');
    }
    if (missing.length) {
      html += '<div class="test-missing">⚠ No test class found for: ' + missing.map(escapeHtmlJs).join(', ') + ' — add one named &lt;Class&gt;Test, or switch to "Run ALL tests" to be safe.</div>';
    }
    if (!found.length && !missing.length) { html = 'No Apex classes selected — the environment\\'s default test level applies.'; }
    detail.innerHTML = html;
  }

  // Respects the current story/PR filter — only (de)selects rows that are currently visible.
  function selectAll(env, checked) {
    document.querySelectorAll('.file-check[data-env="' + env + '"]').forEach(function (cb) {
      var row = cb.closest('.tree-row');
      if (!row || row.style.display !== 'none') { cb.checked = checked; }
    });
    recomputeSelection(env);
  }

  function filterTree(env) {
    var sel = document.querySelector('.story-filter[data-env="' + env + '"]');
    var val = sel ? sel.value : '';
    document.querySelectorAll('.tree-row[data-env="' + env + '"]').forEach(function (row) {
      var stories = (row.dataset.stories || '').split(',');
      row.style.display = (!val || stories.indexOf(val) !== -1) ? '' : 'none';
    });
    document.querySelectorAll('.type-group[data-env="' + env + '"]').forEach(function (grp) {
      var anyVisible = Array.prototype.some.call(grp.querySelectorAll('.tree-row'), function (r) { return r.style.display !== 'none'; });
      grp.style.display = anyVisible ? '' : 'none';
    });
  }

  // A real Validate/Deploy now runs async and polls for minutes, not one blocking call — with
  // nothing else in the DOM changing meanwhile, the panel can look "frozen" even though it's
  // working exactly as expected. Shows a visible busy state immediately on click so there's
  // no doubt something is happening; the next refresh() (always sent once the action finishes,
  // success or failure) replaces the whole panel and clears this on its own. The safety
  // timeout only guards the pathological case where that refresh never arrives at all.
  var BUSY_TIMEOUT_MS = 20 * 60 * 1000;
  var busyTimeouts = {};
  function showBusy(env, label) {
    var bar = document.getElementById('busyBar-' + env);
    if (bar) { bar.hidden = false; bar.innerHTML = '<span class="spin">&#9696;</span> ' + escapeHtmlJs(label); }
    var validateBtn = document.getElementById('validateBtn-' + env);
    var deployBtn = document.getElementById('deployBtn-' + env);
    if (validateBtn) { validateBtn.disabled = true; }
    if (deployBtn) { deployBtn.disabled = true; }
    clearTimeout(busyTimeouts[env]);
    busyTimeouts[env] = setTimeout(function () {
      if (bar) { bar.hidden = true; }
      if (validateBtn) { validateBtn.disabled = false; }
      updateDeployButtonState(env);
    }, BUSY_TIMEOUT_MS);
  }

  function runAction(env, actionMode) {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.file-check[data-env="' + env + '"]:checked'));
    var files = boxes.map(function (b) { return b.value; });
    var autoCb = document.getElementById('autoDeploy-' + env);
    var autoDeployOnSuccess = Boolean(autoCb && autoCb.checked);
    showBusy(env, (actionMode === 'deploy' ? 'Deploying' : 'Validating') + ' against ' + env + '…');
    send('runAction', { env: env, actionMode: actionMode, selectionMode: 'files', files: files, autoDeployOnSuccess: autoDeployOnSuccess, testMode: currentTestMode(env) });
  }

  // Used only when the tree is empty (never deployed before) — nothing to individually check.
  function bootstrapAction(env, actionMode) {
    var autoCb = document.getElementById('autoDeploy-' + env);
    var autoDeployOnSuccess = Boolean(autoCb && autoCb.checked);
    showBusy(env, (actionMode === 'deploy' ? 'Deploying' : 'Validating') + ' against ' + env + '…');
    send('runAction', { env: env, actionMode: actionMode, selectionMode: 'all', autoDeployOnSuccess: autoDeployOnSuccess, testMode: currentTestMode(env) });
  }

  function viewFileDiff(targetEnv, beforeRef, beforeLabel, afterRef, afterLabel, path) {
    send('viewFileDiff', { targetEnv: targetEnv, beforeRef: beforeRef, beforeLabel: beforeLabel, afterRef: afterRef, afterLabel: afterLabel, path: path });
  }

  function viewPendingFileDiff(env, path) {
    send('viewPendingFileDiff', { env: env, path: path });
  }

  function rollback(env) {
    send('rollback', { env: env });
  }

  function escapeHtmlJs(s) {
    return String(s).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; });
  }

  // Line-level LCS diff. Guarded by size since it's O(lines_a * lines_b) time and memory —
  // past that it falls back to a plain whole-file replace view instead of hanging the tab.
  var DIFF_CELL_LIMIT = 4000000;
  function computeLineDiff(a, b) {
    var n = a.length, m = b.length;
    if (n * m > DIFF_CELL_LIMIT) { return null; }
    var dp = new Array(n + 1);
    for (var i = 0; i <= n; i++) { dp[i] = new Uint32Array(m + 1); }
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var result = [];
    i = 0; var j2 = 0;
    while (i < n && j2 < m) {
      if (a[i] === b[j2]) { result.push({ type: 'same', line: a[i] }); i++; j2++; }
      else if (dp[i + 1][j2] >= dp[i][j2 + 1]) { result.push({ type: 'del', line: a[i] }); i++; }
      else { result.push({ type: 'add', line: b[j2] }); j2++; }
    }
    while (i < n) { result.push({ type: 'del', line: a[i] }); i++; }
    while (j2 < m) { result.push({ type: 'add', line: b[j2] }); j2++; }
    return result;
  }

  var CONTEXT_LINES = 3;
  var COLLAPSE_AFTER = 8;

  function renderDiffLines(entries) {
    var html = [];
    var aNo = 0, bNo = 0;
    var added = 0, deleted = 0;
    var run = []; // buffered consecutive 'same' entries, so a long unchanged stretch can collapse

    function flushRun() {
      if (run.length === 0) { return; }
      if (run.length <= COLLAPSE_AFTER) {
        run.forEach(function (r) { html.push(r.html); });
      } else {
        for (var k = 0; k < CONTEXT_LINES; k++) { html.push(run[k].html); }
        html.push('<div class="diffline diff-context">⋯ ' + (run.length - 2 * CONTEXT_LINES) + ' unchanged line(s) ⋯</div>');
        for (var k2 = run.length - CONTEXT_LINES; k2 < run.length; k2++) { html.push(run[k2].html); }
      }
      run = [];
    }

    entries.forEach(function (e) {
      if (e.type === 'same') {
        aNo++; bNo++;
        var gutter = String(aNo).padStart(4, ' ') + ' ' + String(bNo).padStart(4, ' ');
        run.push({ html: '<div class="diffline diff-same"><span class="gutter">' + gutter + '</span><span class="marker"> </span><span class="txt">' + escapeHtmlJs(e.line) + '</span></div>' });
        return;
      }
      flushRun();
      if (e.type === 'add') {
        bNo++; added++;
        var g = '     ' + String(bNo).padStart(4, ' ');
        html.push('<div class="diffline diff-add"><span class="gutter">' + g + '</span><span class="marker">+</span><span class="txt">' + escapeHtmlJs(e.line) + '</span></div>');
      } else {
        aNo++; deleted++;
        var g2 = String(aNo).padStart(4, ' ') + '     ';
        html.push('<div class="diffline diff-del"><span class="gutter">' + g2 + '</span><span class="marker">-</span><span class="txt">' + escapeHtmlJs(e.line) + '</span></div>');
      }
    });
    flushRun();

    return { html: html.join(''), added: added, deleted: deleted };
  }

  function splitLines(text) { return text.length ? text.split('\\n') : []; }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.command === 'fileDiffResult') {
      var titleEl = document.getElementById('diffTitle-' + msg.targetEnv);
      var metaEl  = document.getElementById('diffMeta-' + msg.targetEnv);
      var bodyEl  = document.getElementById('diffBody-' + msg.targetEnv);
      var statEl  = document.getElementById('diffStat-' + msg.targetEnv);
      if (!titleEl || !bodyEl) { return; }
      titleEl.textContent = msg.path;
      metaEl.textContent = msg.beforeLabel + '  →  ' + msg.afterLabel;

      if (msg.before === msg.after) {
        bodyEl.innerHTML = '<div class="diffline diff-context">No differences.</div>';
        statEl.innerHTML = '';
      } else if (msg.before === null) {
        var addLines = splitLines(msg.after || '');
        bodyEl.innerHTML = addLines.map(function (l, idx) {
          return '<div class="diffline diff-add"><span class="gutter">     ' + String(idx + 1).padStart(4, ' ') + '</span><span class="marker">+</span><span class="txt">' + escapeHtmlJs(l) + '</span></div>';
        }).join('');
        statEl.innerHTML = '<b>New file</b> — <span class="plus">+' + addLines.length + '</span>';
      } else if (msg.after === null) {
        var delLines = splitLines(msg.before || '');
        bodyEl.innerHTML = delLines.map(function (l, idx) {
          return '<div class="diffline diff-del"><span class="gutter">' + String(idx + 1).padStart(4, ' ') + '     </span><span class="marker">-</span><span class="txt">' + escapeHtmlJs(l) + '</span></div>';
        }).join('');
        statEl.innerHTML = '<b>Deleted</b> — <span class="minus">-' + delLines.length + '</span>';
      } else {
        var diff = computeLineDiff(splitLines(msg.before), splitLines(msg.after));
        if (diff === null) {
          bodyEl.innerHTML = '<div class="diffline diff-context">File too large to diff line-by-line — showing raw content instead.</div>'
            + '<pre style="white-space:pre-wrap;padding:8px;margin:0">' + escapeHtmlJs(msg.before) + '\\n---\\n' + escapeHtmlJs(msg.after) + '</pre>';
          statEl.innerHTML = '';
        } else {
          var rendered = renderDiffLines(diff);
          bodyEl.innerHTML = rendered.html;
          statEl.innerHTML = '<span class="plus">+' + rendered.added + '</span>&nbsp;&nbsp;<span class="minus">-' + rendered.deleted + '</span>';
        }
      }
    }
  });

  document.querySelectorAll('.pane').forEach(function (p) {
    recomputeSelection(p.dataset.env); // also sets the initial Deploy-button lock state
  });
</script>
</body>
</html>`;
    }

    /** Unified per-environment pane: header, outcome banner, 35/65 split (checkbox tree + live diff), Validate/Deploy actions. */
    private _renderEnvPane(m: EnvViewModel): string {
        const env = m.env;
        const shortSha = (s: string | null) => s ? s.slice(0, 7) : "—";
        const lastDeployText = m.lastDeploy
            ? `Last deployed <code>${shortSha(m.lastDeploy.sha)}</code> on ${new Date(m.lastDeploy.deployedAt).toLocaleString()}`
            : `Never deployed from this dashboard`;

        const noticeIfNoOrg = m.orgAliasSet ? "" : `<div class="warn">⚠ No org alias set for ${escapeHtml(env.label)} — set sfDevops.environments[].orgAlias to enable deploy/validate here.</div>`;
        const noticeIfNoRole = m.canDeploy ? "" : `<div class="warn">⚠ Your role can't deploy to ${escapeHtml(env.label)} (requires "${escapeHtml(env.requiredRole ?? "")}").</div>`;
        const disabled = (!m.orgAliasSet || !m.canDeploy) ? "disabled" : "";

        const outcome = this._lastOutcome && this._lastOutcome.env === env.name ? this._lastOutcome : undefined;
        const outcomeHtml = outcome
            ? `<div class="outcome outcome-${outcome.kind}">${escapeHtml(outcome.message)}${
                outcome.nextEnv
                    ? ` <a onclick="rebind('${outcome.nextEnv.name}')">→ ${escapeHtml(outcome.nextEnv.label)} (${outcome.storyCount ?? 0} story/PR group(s) ready)</a>`
                    : ""
              }</div>`
            : "";
        // Deploy's actual enabled/disabled state is driven live by client-side JS (see
        // updateDeployButtonState) so it reacts the instant checkboxes change — this is only
        // the "hard" reasons that never change without a fresh render (no org alias, no role).
        const validatedFingerprint = this._validatedSelections.get(env.name) ?? null;
        // A successful Validate triggers a full refresh(), which re-renders the tree with every
        // checkbox back to unchecked — without restoring the validated selection here, Deploy
        // would immediately re-lock itself right after Validate passed, forcing the user to
        // re-check the exact same files for no reason. Pre-checking them keeps it unlocked.
        const validatedPaths = validatedFingerprint !== null
            ? new Set(validatedFingerprint.split("|").filter(Boolean))
            : null;

        // Group pending files by Salesforce metadata type for the tree, and note which story/PR
        // group(s) touch each file (a file can be shared — see StoryChangeGroup.sharedWith).
        const storiesByPath = new Map<string, string[]>();
        for (const g of m.groups) {
            for (const f of g.files) {
                const arr = storiesByPath.get(f.path) ?? [];
                arr.push(g.storyId);
                storiesByPath.set(f.path, arr);
            }
        }
        const byType = new Map<string, AuditChangedFile[]>();
        const unmappedFiles: AuditChangedFile[] = [];
        for (const f of m.allFiles) {
            const type = metadataTypeForPath(f.path);
            if (type) {
                if (!byType.has(type)) { byType.set(type, []); }
                byType.get(type)!.push(f);
            } else {
                unmappedFiles.push(f);
            }
        }
        const renderFileRow = (f: AuditChangedFile) => {
            const stories = storiesByPath.get(f.path) ?? [];
            const checked = validatedPaths?.has(f.path) ? " checked" : "";
            const apexName = f.path.endsWith(".cls") ? f.path.split("/").pop()!.replace(/\.cls$/, "") : null;
            const apexAttr = apexName && Object.prototype.hasOwnProperty.call(m.apexTestMap, apexName)
                ? ` data-apex-name="${escapeHtml(apexName)}"` : "";
            const isMeta = f.path.endsWith("-meta.xml");
            const name = f.path.split("/").pop() ?? f.path;
            const date = m.fileDates[f.path] ?? "";
            return `<li class="tree-row${isMeta ? " meta-file" : ""}" data-env="${env.name}" data-stories="${stories.map(escapeHtml).join(",")}" data-name="${escapeHtml(name)}" data-date="${escapeHtml(date)}"${apexAttr}>
          <input type="checkbox" class="file-check" data-env="${env.name}" value="${escapeHtml(f.path)}"${checked} onchange="toggleFile('${env.name}', this)">
          <span class="change ${f.change}">${f.change}</span>
          <span class="file-path clickable" onclick="viewPendingFileDiff('${env.name}','${escapeHtml(f.path)}')" title="Preview diff">${escapeHtml(f.path)}</span>
          ${stories.length ? `<span class="story-badge" title="story/PR">${stories.map(escapeHtml).join(", ")}</span>` : ""}
        </li>`;
        };
        const typeGroupsHtml = Array.from(byType.keys()).sort().map(type => `
      <details class="type-group" data-env="${env.name}" open>
        <summary>${escapeHtml(type)} (${byType.get(type)!.length})</summary>
        <ul class="files">${byType.get(type)!.map(renderFileRow).join("")}</ul>
      </details>`).join("");
        const unmappedHtml = unmappedFiles.length
            ? `<details class="type-group" data-env="${env.name}" open>
             <summary>Other (${unmappedFiles.length})</summary>
             <ul class="files">${unmappedFiles.map(renderFileRow).join("")}</ul>
           </details>`
            : "";

        const neverDeployed = m.allFiles.length === 0 && !m.lastDeploy && m.currentSha;
        // Bootstrap mode has no checkboxes to react to, so (unlike the main Deploy button)
        // this one's gate is computed once, server-side, per render — "" is the fingerprint
        // of an empty selection, i.e. what "Validate ALL" records when there's nothing tracked.
        const bootstrapDeployDisabled = Boolean(disabled) || validatedFingerprint !== "";
        const bootstrapHtml = neverDeployed
            ? `<div class="meta">Never deployed from this dashboard yet — nothing to individually select.</div>
           <div class="actions">
             <button class="btn btn-secondary" ${disabled} onclick="bootstrapAction('${env.name}','validate')">🔍 Validate ALL</button>
             <button class="btn btn-primary" ${bootstrapDeployDisabled ? "disabled" : ""} onclick="bootstrapAction('${env.name}','deploy')" title="${validatedFingerprint === "" ? "" : "Run Validate ALL first"}">🚀 Deploy ALL (nothing tracked yet)</button>
           </div>`
            : "";
        const upToDateHtml = (m.allFiles.length === 0 && !neverDeployed)
            ? `<div class="meta">No pending changes — ${escapeHtml(env.label)} is up to date.</div>`
            : "";

        const filterOptions = m.groups.map(g => `<option value="${escapeHtml(g.storyId)}">${escapeHtml(g.storyId)} (${g.files.length})</option>`).join("");

        const diffVsNextBlock = m.nextEnv
            ? `<details class="diff">
          <summary>Preview diff: ${escapeHtml(env.label)} vs ${escapeHtml(m.nextEnv.label)} (${m.diffVsNext?.length ?? 0} file(s) different)</summary>
          <ul class="files">
            ${(m.diffVsNext ?? []).map(f => `<li class="clickable" onclick="viewFileDiff('${env.name}','${env.branch}','${escapeHtml(env.label)}','${m.nextEnv!.branch}','${escapeHtml(m.nextEnv!.label)}','${escapeHtml(f.path)}')"><span class="change ${f.change}">${f.change}</span>${escapeHtml(f.path)}</li>`).join("")}
          </ul>
        </details>`
            : "";

        const manifestBlock = m.allFiles.length
            ? `<details class="diff"><summary>package.xml preview (${m.allFiles.length} file(s))</summary><pre class="manifest">${escapeHtml(m.packageXml)}</pre>${m.unmapped.length ? `<div class="warn">Not in manifest: ${m.unmapped.map(escapeHtml).join(", ")}</div>` : ""}</details>`
            : "";

        // Only shown when there's actually Apex pending here — a metadata-only deploy has
        // nothing to auto-pick tests for, and forcing the choice on the user every time would
        // just be noise. Content of #testsInfo is filled in live by updateTestsPanel(), driven
        // by whichever Apex classes are (or, in bootstrap mode, would be) actually checked.
        const hasApex = Object.keys(m.apexTestMap).length > 0;
        const testsPanel = hasApex
            ? `<div class="tests-panel" id="testsPanel-${env.name}">
            <div class="tests-panel-head">🧪 Tests to run</div>
            <div class="tests-mode-row">
              <label><input type="radio" name="testMode-${env.name}" value="auto" checked onchange="updateTestsPanel('${env.name}')"> Auto-detected tests for selected Apex classes</label>
              <label><input type="radio" name="testMode-${env.name}" value="all" onchange="updateTestsPanel('${env.name}')"> Run ALL tests in org</label>
            </div>
            <div class="tests-detail" id="testsDetail-${env.name}"></div>
          </div>`
            : "";

        return `
<div class="pane" data-env="${env.name}" data-has-validated="${validatedFingerprint !== null ? "1" : "0"}" data-validated-fp="${escapeHtml(validatedFingerprint ?? "")}" data-apex-test-map='${escapeHtml(JSON.stringify(m.apexTestMap))}'>

<section class="env">
  <h2>${escapeHtml(env.label)} <span class="meta">(${escapeHtml(env.branch)} → ${escapeHtml(env.orgAlias || "no org alias")})</span></h2>
  <div class="meta">${lastDeployText}</div>
  <div class="meta">📍 Everything below reflects <code>origin/${escapeHtml(env.branch)}</code> — the last commit actually <b>pushed</b> to that branch. Your local working tree (uncommitted edits, unpushed local commits, anything not on this remote branch) is never part of what gets validated or deployed here.</div>
  ${noticeIfNoOrg}${noticeIfNoRole}
  ${outcomeHtml}

  <div class="split">
    <div class="split-left">
      ${m.groups.length ? `<select class="story-filter" data-env="${env.name}" onchange="filterTree('${env.name}')">
        <option value="">All stories/PRs (${m.groups.length})</option>
        ${filterOptions}
      </select>` : ""}

      ${m.allFiles.length ? `<div class="select-row">
        <a onclick="selectAll('${env.name}', true)">Select all</a> ·
        <a onclick="selectAll('${env.name}', false)">Select none</a>
      </div>
      <div class="tree-controls">
        <label class="show-meta-label" title="Meta files (-meta.xml) are always deployed together with their component regardless of this — this only controls whether their own row is shown.">
          <input type="checkbox" id="showMeta-${env.name}" onchange="toggleShowMeta('${env.name}')">
          Show meta files
        </label>
        <label class="sort-label">
          Sort:
          <select class="sort-select" data-env="${env.name}" onchange="applySort('${env.name}')">
            <option value="name">Name</option>
            <option value="date">Date updated</option>
          </select>
        </label>
      </div>` : ""}

      <div class="selection-summary" id="selSummary-${env.name}">No files selected.</div>

      <div class="tree hide-meta" id="tree-${env.name}">
        ${typeGroupsHtml}${unmappedHtml}
        ${bootstrapHtml}${upToDateHtml}
      </div>

      ${diffVsNextBlock}
      ${manifestBlock}
    </div>

    <div class="split-right">
      <div class="diffTitle" id="diffTitle-${env.name}">Select a file on the left to preview its diff.</div>
      <div class="meta diffMeta" id="diffMeta-${env.name}"></div>
      <div class="diffStat" id="diffStat-${env.name}"></div>
      <div class="diffBody" id="diffBody-${env.name}"></div>
    </div>
  </div>

  ${testsPanel}

  <div class="busy-bar" id="busyBar-${env.name}" hidden></div>

  <div class="deploy-row">
    <label class="auto-deploy-label" title="${env.isProd ? "Prod always requires a manual Deploy click, regardless of this checkbox." : "If Validate succeeds, immediately run a real Deploy with the same selection."}">
      <input type="checkbox" id="autoDeploy-${env.name}" ${env.isProd ? "disabled" : ""}>
      Auto-deploy on success
      ${env.isProd ? `<span class="meta">(Prod always requires a manual Deploy click)</span>` : ""}
    </label>
    <button class="btn btn-secondary" id="validateBtn-${env.name}" ${disabled} onclick="runAction('${env.name}','validate')">🔍 Validate</button>
    <button class="btn btn-primary" id="deployBtn-${env.name}" data-hard-disabled="${disabled ? "1" : "0"}" disabled title="Run Validate on this exact selection first">🚀 Deploy</button>
    ${m.lastDeploy && m.canDeploy ? `<button class="btn btn-secondary" title="Redeploy the entire source at the last-deployed commit (${m.lastDeploy.sha.slice(0,8)}) to roll back a bad promotion" onclick="rollback('${env.name}')">↩ Rollback</button>` : ""}
  </div>
</section>
</div>`;
    }
}

function dedupe(files: AuditChangedFile[]): AuditChangedFile[] {
    const seen = new Map<string, AuditChangedFile>();
    for (const f of files) { seen.set(f.path, f); }
    return Array.from(seen.values());
}

/** How many story/PR groups the given files touch — used for the "N story/PR(s) ready" banner text. Exact for "all"/"stories" selections; an honest approximation for a partial file-mode selection. */
function countTouchedGroups(groups: StoryChangeGroup[], files: AuditChangedFile[]): number {
    const paths = new Set(files.map(f => f.path));
    return groups.filter(g => g.files.some(f => paths.has(f.path))).length;
}

/** The story ids a given file selection actually touches — same matching countTouchedGroups uses, just returning which, not how many. */
function touchedStoryIds(groups: StoryChangeGroup[], files: AuditChangedFile[]): string[] {
    const paths = new Set(files.map(f => f.path));
    return groups.filter(g => g.files.some(f => paths.has(f.path))).map(g => g.storyId);
}

/** Identifies a file selection by its exact contents (order-independent) — used to check whether Deploy's current selection is exactly what Validate last passed for. */
function fingerprintFiles(files: AuditChangedFile[]): string {
    return files.map(f => f.path).sort().join("|");
}

/** Short human summary of which tests actually ran — shown in the outcome banner. */
function testLevelSummary(testLevel: string, tests?: string[]): string {
    if (testLevel === "RunSpecifiedTests" && tests?.length) { return `tests: ${tests.join(", ")}`; }
    if (testLevel === "RunAllTestsInOrg") { return "all org tests"; }
    if (testLevel === "NoTestRun") { return "no tests run"; }
    return testLevel;
}
