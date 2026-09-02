// promoteStory.ts — "Promote & Deploy" and "Validate Only" commands (QA/UAT).
// Copado model, now a single unified sequence regardless of which button you click:
//   [Trigger] → 1. Create Promo Branch → 2. Validate (real check-only deploy vs the target
//   org) → 3. Open PR (promotion → env; merging it is the human review gate) → 4. Deploy &
//   Clean Up (separate, explicit — see DeploymentDashboardPanel).
// Validation is MANDATORY before a PR can be opened — "Validate Only" runs steps 1-2 and
// stops; "Promote & Deploy" runs 1-2-3, auto-advancing through whichever of those isn't
// already done yet (re-validating if the branch has moved since it last passed). There is
// no path that opens a PR without a real, currently-passing validate result for that exact
// branch content — see GitHelper.isPromotionValidated/recordPromotionValidated.
// Cherry-pick conflicts (step 1) are left in place for the resolve-and-resume flow.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper, warnUncommittedChanges } from "../GitHelper";
import { StoryWebviewProvider } from "../providers/StoryWebviewProvider";
import { coverageSettings } from "./coverageCheck";
import { runDeploy, DeployResult } from "../DeploymentEngine";
import { apexClassNamesIn, buildApexTestMap, resolveEffectiveTestLevel } from "../DeploymentPlanner";
import {
    isFeatureBranch, extractStoryId, getFeatureBranchPrefix,
    getCoverageGateEnvironment, promoBranchName, getBaseBranch, featureBranchName, getEnvironments,
    findEnvironment, getPromotableEnvironments, getSourceRootFolder, getDeployTimeoutSeconds,
    ResolvedEnvironment,
} from "../config";
import { buildPackageXml, AuditChangedFile } from "../AuditLog";
import { buildDiffUris } from "../DiffContentProvider";

export type PromoteMode = "validate" | "promote";

/**
 * "Review Changes" — a real VS Code diff editor per file, current content on `targetBranch`
 * vs incoming content on `featureBranch`, so the confirm step isn't just a file list. Loops
 * the picker so multiple files can be reviewed in one pass; Esc (or picking nothing) returns
 * control to the caller, which re-shows the actual confirm/cancel dialog.
 */
export async function reviewStoryDiff(
    gitHelper:     GitHelper,
    featureBranch: string,
    targetBranch:  string,
    files:         { path: string; change: "added" | "modified" | "deleted" }[]
): Promise<void> {
    if (files.length === 0) { return; }
    const icon = (change: string) =>
        change === "added" ? "$(diff-added)" : change === "deleted" ? "$(diff-removed)" : "$(diff-modified)";

    while (true) {
        const pick = await vscode.window.showQuickPick(
            files.map(f => ({ label: `${icon(f.change)} ${f.path}`, description: f.change, file: f })),
            {
                title: `Review changes — ${featureBranch} → ${targetBranch} (${files.length} file(s))`,
                placeHolder: "Select a file to view its diff — Esc to close",
            }
        );
        if (!pick) { return; }
        const { before, after } = buildDiffUris(pick.file.path, targetBranch, featureBranch);
        await vscode.commands.executeCommand(
            "vscode.diff", before, after, `${pick.file.path} (${targetBranch} ↔ ${featureBranch})`
        );
    }
}

/** Metadata changed on the story's feature branch vs base — used for the audit trail. */
async function storyChangedFiles(gitHelper: GitHelper, storyId: string): Promise<AuditChangedFile[]> {
    try {
        return await gitHelper.diffNameStatusBetween(getBaseBranch(), featureBranchName(storyId));
    } catch {
        return [];
    }
}

/**
 * Branch-scoped wrapper: derives the story from whatever's currently checked out, then
 * runs the shared promotion flow. Used by "Validate Only," which stays tied to the
 * current branch. "Promote" itself goes through the multi-story picker (promotePicker.ts)
 * → runPromotion directly, since promoting shouldn't require checking out a branch first.
 */
export async function promoteStory(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    targetEnv:     string,
    mode:          PromoteMode,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const branch = await gitHelper.currentBranch();

    if (!isFeatureBranch(branch)) {
        vscode.window.showWarningMessage("You must be on a feature branch to promote or validate.");
        return;
    }

    const storyId = extractStoryId(branch) || branch!.replace(getFeatureBranchPrefix(), "");
    await runPromotion(bbClient, gitHelper, storyId, targetEnv, mode, storyProvider);
}

/**
 * Runs the real check-only Salesforce deploy for a promotion branch's actual content
 * (its diff vs. the target branch it was cut from) against the target org — this is what
 * makes "mandatory validation" real rather than aspirational: a promotion branch existing
 * is no longer enough to open a PR from, this has to have genuinely passed for its current
 * sha. Leaves the workspace checked out on the promotion branch; callers are expected to
 * return to the feature branch themselves once they're done (mirrors the existing
 * checkoutFeature-at-the-end pattern the rest of this file already uses).
 *
 * Tests are auto-detected the same way the Deployment Dashboard already does (see
 * DeploymentPlanner.resolveEffectiveTestLevel) rather than always using the environment's
 * static deployTestLevel — a mandatory validate step that's slow enough to feel "stuck" on
 * every single promotion (RunLocalTests runs the org's ENTIRE local test suite, not just
 * what this story touches) would defeat the point of making it mandatory. Falls back to the
 * configured level only when there's no Apex in the diff to auto-detect a test for.
 */
async function runPromotionValidate(
    gitHelper: GitHelper,
    storyId:   string,
    targetEnv: string,
    envCfg:    ResolvedEnvironment,
    progress?: vscode.Progress<{ message?: string }>
): Promise<DeployResult> {
    const promotionBranch = gitHelper.promoBranchName(storyId, targetEnv, "promote");
    const targetBranch    = envCfg.branch;

    progress?.report({ message: `Switching local checkout to origin/${promotionBranch} and pulling latest...` });
    await gitHelper.createLocalBranchFrom(promotionBranch, promotionBranch);

    let files = await gitHelper.diffNameStatusBetween(targetBranch, promotionBranch);
    if (files.length === 0) {
        // Nothing actually differs from the target branch (e.g. re-validating a no-op
        // reuse) — nothing to check-only deploy, so there's nothing to fail either.
        return { ran: false, success: true, numberComponentsDeployed: 0 };
    }

    // A deleted file doesn't exist on disk after the checkout above — passing it as
    // --source-dir makes the CLI fail outright with "File or folder not found" (this is
    // literally what buildPackageXml's manifest preview already excludes deletions for —
    // "real deletions belong in destructiveChanges.xml, not here" — but that fix never made
    // it into what's actually sent to the CLI). Deletions aren't deployable this way at all
    // yet, so drop them from what's sent and say so clearly instead of crashing or silently
    // dropping them with no explanation.
    const deletedFiles = files.filter(f => f.change === "deleted");
    if (deletedFiles.length > 0) {
        files = files.filter(f => f.change !== "deleted");
        vscode.window.showWarningMessage(
            `${storyId}: ${deletedFiles.length} deleted file(s) can't be included in this validate/deploy yet ` +
            `(${deletedFiles.slice(0, 3).map(f => f.path.split("/").pop()).join(", ")}${deletedFiles.length > 3 ? ", …" : ""}) — ` +
            `delete them manually in ${targetEnv.toUpperCase()} for now.`
        );
        if (files.length === 0) {
            return { ran: false, success: true, numberComponentsDeployed: 0 };
        }
    }

    const apexClasses = apexClassNamesIn(files);
    let testLevel = envCfg.deployTestLevel;
    let tests: string[] | undefined;
    if (apexClasses.length > 0) {
        const allClsFiles = await gitHelper.listFilesAtRef(promotionBranch, getSourceRootFolder());
        const { apexTestMap, apexTestFilePaths } = buildApexTestMap(allClsFiles, apexClasses);
        ({ testLevel, tests } = resolveEffectiveTestLevel(envCfg.deployTestLevel, "auto", apexClasses, apexTestMap));

        // Same fold-in as the Dashboard: RunSpecifiedTests requires the named test class to
        // actually be part of the deployment package (or already exist in the org) — make
        // sure it's always included even if it wasn't otherwise part of the diff.
        if (testLevel === "RunSpecifiedTests" && tests?.length) {
            const present = new Set(files.map(f => f.path));
            const extra = tests.flatMap(t => apexTestFilePaths[t] ?? []).filter(p => !present.has(p));
            if (extra.length > 0) { files = [...files, ...extra.map(p => ({ path: p, change: "modified" as const }))]; }
        }
    }

    progress?.report({ message: `Validating against ${targetEnv.toUpperCase()}...` });
    return runDeploy(
        gitHelper.getWorkspaceRoot(),
        getSourceRootFolder(),
        files.map(f => f.path),
        envCfg.orgAlias ?? "",
        testLevel,
        getDeployTimeoutSeconds(),
        "validate",
        tests,
        status => progress?.report({ message: status })
    );
}

export async function runPromotion(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyId:       string,
    targetEnv:     string,
    mode:          PromoteMode,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const envUpper = targetEnv.toUpperCase();
    const envCfg = findEnvironment(targetEnv);
    // The real git branch this environment deploys — usually equal to its name, but can
    // differ (e.g. "prod" → branch "main"). Everything below that needs a real git ref
    // uses this; targetEnv itself stays the logical name for gating/audit/labels.
    const targetBranch = envCfg?.branch ?? targetEnv;

    // Already has an open PR for this exact promotion? Jump straight to it instead of
    // restarting the create-branch/validate sequence — a plain read-only provider-API check,
    // so it runs before the operation lock and doesn't need to "begin" anything. Validate
    // Only is unaffected — it never deals in PRs.
    if (mode === "promote") {
        const promoBranchForPr = promoBranchName(storyId, targetEnv, "promote");
        const repoOverride = await gitHelper.resolveRepoIdentity(bbClient);
        const openPrUrl = await bbClient.getOpenPRUrl(promoBranchForPr, targetBranch, repoOverride);
        if (openPrUrl) {
            vscode.env.openExternal(vscode.Uri.parse(openPrUrl));
            vscode.window.showInformationMessage(`${storyId} already has an open PR into ${envUpper} — opened it instead of starting a new promotion.`);
            return;
        }
    }

    // A real Validate/Promote can take well past a few seconds (branch creation, a git push,
    // often a real Salesforce check-only deploy) — refuse a second click that lands on this
    // exact story+env while one's already running instead of racing two git operations
    // against the same working tree.
    const lockKey = `promote:${storyId}:${targetEnv}`;
    if (!gitHelper.tryBeginOperation(lockKey)) {
        vscode.window.showWarningMessage(`Already ${mode === "validate" ? "validating" : "promoting"} ${storyId} → ${envUpper} — give it a moment to finish before clicking again.`);
        return;
    }

    const originalBranch = await gitHelper.currentBranch();
    let stashLabel: string | null = null;

    try {

    // Hard gate: the stage immediately before targetEnv must actually be deployed (not
    // just merged) — skipped for the first promotable env, whose "previous stage" is the
    // publish env (e.g. dev), which has no deploy step to check. Enforced here so it can't
    // be bypassed by any caller (Command Palette, the picker, a future entry point) —
    // never just a hidden/disabled button.
    const promotable = getPromotableEnvironments();
    const targetIdx = promotable.findIndex(e => e.name === targetEnv);
    if (targetIdx > 0) {
        const gap = await gitHelper.checkPrevEnvDeployed(promotable[targetIdx - 1], envUpper);
        if (gap.blocked) {
            vscode.window.showWarningMessage(gap.reason!);
            return;
        }
    }

    // One-time coverage gate: block the first promotion into the configured gate
    // environment when the story has Apex classes and coverage hasn't reached the
    // threshold in the dev org yet. sfDevops.environments[].coverageGate decides which
    // environment (if any) this applies to.
    const gateEnv = getCoverageGateEnvironment();
    if (mode === "promote" && gateEnv && targetEnv === gateEnv.name) {
        const apex = await gitHelper.featureApexClasses(storyId);
        if (apex.length > 0 && !(await gitHelper.isCoveragePassed(storyId))) {
            const { threshold } = coverageSettings();
            const choice = await vscode.window.showWarningMessage(
                `${storyId} has Apex classes (${apex.slice(0, 4).join(", ")}${apex.length > 4 ? ", …" : ""}). ` +
                `Run the Code Coverage check (≥ ${threshold}%) in the Code Coverage panel before promoting to ${gateEnv.label}.`,
                "Open Coverage Panel"
            );
            if (choice === "Open Coverage Panel") {
                await vscode.commands.executeCommand("sfDevopsCoverageView.focus");
            }
            return;
        }
    }

    // Manual sign-off gate: the environment the story is CURRENTLY sitting in (the one
    // immediately before targetEnv) may require a recorded human sign-off before the
    // story can be promoted onward — e.g. QA sign-off before UAT, then UAT sign-off
    // before whatever's next. sfDevops.environments[].signoffGate decides which
    // environment(s) require this.
    if (mode === "promote") {
        const envs = getEnvironments();
        const signoffIdx = envs.findIndex(e => e.name === targetEnv);
        const currentEnv = signoffIdx > 0 ? envs[signoffIdx - 1] : undefined;
        if (currentEnv?.signoffGate && !(await gitHelper.isSignoffPassed(storyId, currentEnv.name))) {
            vscode.window.showWarningMessage(
                `${currentEnv.label} sign-off hasn't been recorded for ${storyId} yet. Record it in the Current Story panel before promoting to ${envUpper}.`
            );
            return;
        }
    }

    // Hard block, same as the Deployment Dashboard's own guard before its equivalent
    // checkout: every path below (the reuse shortcut's checkoutFeature, and the main
    // sequence's checkout -B for the promotion branch) force-syncs a branch from origin,
    // which git will refuse — or worse, silently collide with — if you have uncommitted
    // changes sitting around anywhere in the working tree right now. Catching it here with
    // a clear, actionable message beats letting a raw git error surface from deep inside
    // beginPromotion/createLocalBranchFrom.
    if (await gitHelper.hasUncommittedChanges()) {
        stashLabel = await warnUncommittedChanges(
            gitHelper,
            `Commit or stash your local changes before ${mode === "validate" ? "validating" : "promoting"} — this checks out a fresh copy of the promotion branch from origin, which would collide with them.`,
            { offerStash: true }
        );
        if (!stashLabel) { return; }
    }

    // Copado reuse: an existing promotion branch skips straight to opening the PR — but
    // ONLY if it's actually been validated for its current content. This used to just
    // trust that the branch existing meant it was safe to open a PR from; that's exactly
    // the loophole "mandatory validation" closes. Not validated (or gone stale since it
    // last passed)? Fall through into the normal sequence below, which re-validates before
    // doing anything else.
    if (mode === "promote" && await gitHelper.promotionBranchExists(storyId, targetEnv)
        && await gitHelper.isPromotionValidated(storyId, targetEnv)) {
        const confirm = await vscode.window.showWarningMessage(
            `Promote & Deploy ${storyId} to ${envUpper}?\n\nThe promotion branch already exists and has passed validation — this will open its PR (promotion → ${targetEnv}). ${envUpper} deploys once you approve & merge it.`,
            { modal: true },
            "Yes, open PR"
        );
        if (!confirm) { return; }
        await openPromotionPR(bbClient, gitHelper, storyId, targetEnv, storyProvider);
        return;
    }

    // An existing-but-unvalidated promotion branch (we already know it's unvalidated —
    // validated+exists returned above via the Copado-reuse shortcut) is never just reused
    // as-is: reused unmodified, it validates against whatever the target branch looked like
    // when it was first cut, which can silently drift as OTHER stories promote into that
    // same env in the meantime — exactly what showed up as spurious "deleted" entries for a
    // branch cut before a later, unrelated promotion landed. Refreshing it — re-cutting from
    // the target's CURRENT tip and re-applying the story's current diff, via the same
    // beginPromotion() a brand-new promotion uses — keeps every validate honest about what
    // it's actually being checked against. The one case that must NOT be refreshed: a
    // cherry-pick left mid-conflict on this exact branch, waiting on Resume — re-cutting
    // would blow away whatever the user just resolved there.
    const pendingOp = await gitHelper.getPendingOperation();
    const hasOwnPendingConflict = Boolean(
        pendingOp && pendingOp.kind === "promotion" && pendingOp.storyId === storyId && pendingOp.targetEnv === targetEnv
    );
    if (hasOwnPendingConflict) {
        vscode.window.showWarningMessage(
            `${storyId} → ${envUpper} has an unresolved conflict from an earlier attempt — resolve it and click Resume instead of Validate/Promote again.`
        );
        return;
    }

    const promoBranch = promoBranchName(storyId, targetEnv, "promote");
    const branchAlreadyExists = await gitHelper.promotionBranchExists(storyId, targetEnv);
    const featureBranch = featureBranchName(storyId);

    // The single biggest source of "wait, what actually got promoted?" confusion: every
    // Validate/Promote works ENTIRELY off `origin/feature/{storyId}` — whatever's actually
    // pushed — never your local working tree. Say so explicitly in the confirm. (There used
    // to also be a softer "you have uncommitted local changes, they won't be included, but
    // proceed anyway if you want" warning scoped to just this branch — the hard block above
    // now covers that same condition unconditionally, the same way Deploy's does, so that
    // softer path can no longer be reached and was removed rather than left as dead code.)
    const sourceNote = `\n\nSource: origin/${featureBranch} (last pushed commit) — never your local uncommitted files.`;

    // Both Promote and Validate get an explicit "here's exactly what's about to go out" file
    // list before anything real happens — previously the only place this list existed was
    // the Output Channel log, written by beginPromotion AFTER the cherry-pick had already
    // started, and only Promote got it even there. Validate is the FIRST gate in the
    // mandatory pipeline, so it's exactly where "what's about to be checked" matters most.
    // Always shown now — an existing branch gets refreshed (see above), so this preview is
    // exactly what that refresh is about to apply. A story with nothing new (already fully
    // promoted) is caught here too, instead of running the branch-creation dance into a
    // doomed no-op.
    let preview: { path: string; change: "added" | "modified" | "deleted" }[];
    try {
        preview = await gitHelper.previewStoryFiles(storyId);
    } catch (err) {
        vscode.window.showErrorMessage(String(err));
        return;
    }
    if (preview.length === 0) {
        vscode.window.showInformationMessage(`${storyId} has nothing new to ${mode === "validate" ? "validate against" : "promote to"} ${envUpper} — it's already up to date there.`);
        return;
    }
    const shown = preview.slice(0, 8).map(f => `  ${f.change === "added" ? "+" : f.change === "deleted" ? "-" : "~"} ${f.path}`);
    const more = preview.length > 8 ? `\n  ...and ${preview.length - 8} more` : "";
    const filesBlock = `\n\n${preview.length} file(s) (from origin/${featureBranch}):\n${shown.join("\n")}${more}`;

    const stageWord = branchAlreadyExists ? "Refresh the promotion branch and validate" : "Create the promotion branch and validate";
    const confirmMsg = mode === "validate"
        ? `Validate ${storyId} against ${envUpper}?\n\nThis will:\n• ${branchAlreadyExists ? `Refresh ${promoBranch} from the current ${targetBranch}` : `Create ${promoBranch} from ${targetBranch}`}\n• Run a real check-only validation against ${envUpper} (no deploy)${filesBlock}${sourceNote}`
        : `Promote ${storyId} to ${envUpper}?\n\nThis will:\n• ${stageWord} — ${branchAlreadyExists ? "refreshes" : "creates"} ${promoBranch} from ${targetBranch}\n• Only once validation passes: open a PR (promotion → ${targetBranch})\n• Deploy to ${envUpper} once you approve & merge the PR${filesBlock}${sourceNote}`;
    const confirmLabel = mode === "validate" ? `Yes, validate against ${envUpper}` : "Yes, Promote";

    // "Review Changes" opens a real per-file diff (current on targetBranch vs incoming from
    // featureBranch) and, once the review is done, re-shows this SAME confirm — a loop rather
    // than a one-shot detour, so reviewing can never accidentally skip the actual confirm or
    // silently proceed/cancel on its own.
    let confirm: string | undefined;
    while (true) {
        confirm = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, "Review Changes", confirmLabel);
        if (confirm === "Review Changes") {
            await reviewStoryDiff(gitHelper, featureBranch, targetBranch, preview);
            continue;
        }
        break;
    }
    if (!confirm) { return; }

    // Another story (or the same story against a different env) can be sitting mid-conflict
    // right now — beginPromotion would otherwise silently `cherry-pick --abort` it with no
    // warning, orphaning its "Resume" entirely. Surface it and let the user choose instead.
    // Always checked now — beginPromotion always runs below, whether creating fresh or
    // refreshing an existing branch.
    let discardConflicting = false;
    {
        const conflicting = await gitHelper.conflictingPendingOperation(storyId, targetEnv);
        if (conflicting) {
            const label = `${conflicting.storyId}${conflicting.targetEnv ? ` → ${conflicting.targetEnv}` : " (dev publish)"}`;
            const choice = await vscode.window.showWarningMessage(
                `${label} has an unresolved conflict from an earlier operation.\n\n` +
                `Starting this now will discard that conflict and its "Resume" state — the other operation cannot be recovered afterward.`,
                { modal: true },
                "Discard it and continue"
            );
            if (!choice) { return; }
            discardConflicting = true;
        }
    }

    await vscode.window.withProgress(
        {
            location:    vscode.ProgressLocation.Notification,
            title:       `${mode === "validate" ? "Validating" : "Promoting"} ${storyId} → ${envUpper}...`,
            cancellable: false,
        },
        async (progress) => {
            try {
                progress.report({ message: branchAlreadyExists ? "① Refreshing promotion branch..." : "① Creating promotion branch..." });
                const outcome = await gitHelper.beginPromotion(storyId, targetEnv, mode, targetBranch, discardConflicting);

                if (outcome.status === "conflict") {
                    const changedFiles = await storyChangedFiles(gitHelper, storyId);
                    const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);
                    await gitHelper.appendAudit({
                        operation: mode, storyId, targetEnv, outcome: "conflict",
                        summary: `Conflict preparing promotion branch for ${envUpper}`,
                        details: { changedFiles, packageXml, unmappedFiles, conflicts: outcome.conflicts },
                    });
                    await reportOperationConflict(gitHelper, outcome.conflicts, envUpper);
                    storyProvider.refresh();
                    return;
                }

                progress.report({ message: "① Pushing promotion branch..." });
                await gitHelper.finalizePromotion(storyId, targetEnv, mode);

                await finalizeAndFinish(bbClient, gitHelper, storyId, targetEnv, mode, storyProvider, progress);
            } catch (err) {
                await gitHelper.appendAudit({
                    operation: mode, storyId, targetEnv, outcome: "failure",
                    summary: `${mode === "validate" ? "Validation" : "Promotion"} failed`,
                    details: { error: String(err) },
                });
                vscode.window.showErrorMessage(`${mode === "validate" ? "Validation" : "Promotion"} failed: ${err}`);
            }
        }
    );
    } finally {
        if (stashLabel) {
            // Land back wherever the stash was actually taken from before popping it —
            // finalizeAndFinish always ends on the feature branch, which usually IS where the
            // dirty tree was, but doesn't have to be (see the "dirty branch isn't the story's
            // own feature branch" case).
            if (originalBranch) { await gitHelper.checkoutBranch(originalBranch).catch(() => {}); }
            const restore = await gitHelper.restoreStash(stashLabel);
            if (restore.status === "conflict") {
                vscode.window.showWarningMessage(
                    `Your stashed changes are safe but conflicted while restoring — resolve the conflict markers now showing in your files (Source Control view), then run "git stash drop" to finish (stash: ${restore.ref}).`
                );
            }
        }
        gitHelper.endOperation(lockKey);
    }
}

/**
 * ② Validate, MANDATORY, every time — whether reached via "Validate Only" or "Promote" —
 * then, only for "promote" and only once validation actually passed, ③ opens the PR. A
 * promotion branch with no currently-passing validate result never reaches step ③. Also
 * the resume point after a resolved cherry-pick conflict (see resumePromotion.ts) — a
 * conflict can only happen during step ① (branch creation), so resuming from one always
 * means "the branch is ready, now validate it," same as the fresh-branch path above.
 */
export async function finalizeAndFinish(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyId:       string,
    targetEnv:     string,
    mode:          PromoteMode,
    storyProvider: StoryWebviewProvider,
    progress?:     vscode.Progress<{ message?: string }>
): Promise<void> {
    const envUpper = targetEnv.toUpperCase();
    const envCfg = findEnvironment(targetEnv);
    if (!envCfg) {
        vscode.window.showErrorMessage(`Unknown environment "${targetEnv}" — check sfDevops.environments.`);
        return;
    }

    // Callers are expected to have already pushed any fresh local content on the promotion
    // branch (a just-completed cherry-pick or conflict resolution) BEFORE calling this —
    // this function only validates+PRs whatever is currently on origin. When reusing an
    // already-pushed, not-yet-validated branch with no local checkout in this run (the
    // fallthrough from runPromotion's Copado-reuse check), there's nothing fresh to push;
    // pushing here unconditionally would risk pushing a stale or unrelated local branch by
    // the same name instead of leaving origin's real content alone.
    const valResult = await runPromotionValidate(gitHelper, storyId, targetEnv, envCfg, progress);
    const changedFiles = await storyChangedFiles(gitHelper, storyId);
    const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);

    await gitHelper.appendAudit({
        operation: "validate", storyId, targetEnv,
        outcome: valResult.success ? "success" : "failure",
        summary: valResult.success
            ? `Validated against ${envUpper} — ${valResult.numberComponentsDeployed ?? 0} component(s)`
            : `Validation against ${envUpper} failed — ${valResult.error ?? "see component failures"}`,
        details: {
            changedFiles, packageXml, unmappedFiles,
            componentFailures: valResult.componentFailures,
            testLevel: envCfg.deployTestLevel,
        },
    });

    await gitHelper.checkoutFeature(storyId);

    if (!valResult.success) {
        vscode.window.showErrorMessage(
            `❌ Validation against ${envUpper} failed: ${valResult.error ?? "see the audit trail"}. ` +
            `The promotion branch is left in place — fix the issue and re-run Validate/Promote.`
        );
        storyProvider.refresh();
        return;
    }

    await gitHelper.recordPromotionValidated(storyId, targetEnv, { numberComponentsDeployed: valResult.numberComponentsDeployed });

    if (mode === "validate") {
        vscode.window.showInformationMessage(
            `✅ Validated ${storyId} against ${envUpper} — ${valResult.numberComponentsDeployed ?? 0} component(s), no errors. ` +
            `Click "Promote" to open the PR from this exact validated branch.`
        );
        storyProvider.refresh();
        return;
    }

    // ③ Merge to Target Branch — opens the PR; merging it is the human review gate.
    await openPromotionPR(bbClient, gitHelper, storyId, targetEnv, storyProvider, progress);
}

/**
 * Opens the prefilled "Create pull/merge request" page (promotion → target env) in the
 * browser — step ③, "Merge to Target Branch" (the PR IS the merge mechanism; the actual
 * merge click happens in your browser, this just gets you there with the right branches
 * pre-filled). Hard-refuses if the mandatory validation gate somehow wasn't satisfied —
 * defense in depth beyond the checks already done in runPromotion, so no future call site
 * can accidentally open a PR from an unvalidated branch.
 */
export async function openPromotionPR(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyId:       string,
    targetEnv:     string,
    storyProvider: StoryWebviewProvider,
    progress?:     vscode.Progress<{ message?: string }>
): Promise<void> {
    if (!(await gitHelper.isPromotionValidated(storyId, targetEnv))) {
        vscode.window.showErrorMessage(
            `Can't open a PR for ${storyId} → ${targetEnv.toUpperCase()} — validation hasn't passed for this promotion branch yet. Run Validate first.`
        );
        return;
    }

    const promotionBranch = promoBranchName(storyId, targetEnv, "promote");
    const targetBranch    = findEnvironment(targetEnv)?.branch ?? targetEnv;
    progress?.report({ message: "③ Opening pull request page..." });

    await gitHelper.checkoutFeature(storyId);

    const changedFiles = await storyChangedFiles(gitHelper, storyId);
    const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);

    const repoOverride = await gitHelper.resolveRepoIdentity(bbClient);
    const prUrl = bbClient.buildPrUrl(promotionBranch, targetBranch, repoOverride);
    if (!prUrl) {
        await gitHelper.appendAudit({
            operation: "promote", storyId, targetEnv, branch: promotionBranch, outcome: "success",
            summary: `${promotionBranch} pushed, but PR URL could not be determined`,
            details: { changedFiles, packageXml, unmappedFiles },
        });
        vscode.window.showWarningMessage(
            `${promotionBranch} was pushed, but the repo could not be determined. ` +
            `Set sfDevops.repoWorkspace and sfDevops.repoSlug to auto-open the PR page.`
        );
        storyProvider.refresh();
        return;
    }

    await gitHelper.appendAudit({
        operation: "promote", storyId, targetEnv, branch: promotionBranch, outcome: "success",
        summary: `${promotionBranch} pushed — PR opened against ${targetEnv.toUpperCase()}`,
        details: { changedFiles, packageXml, unmappedFiles, prUrl },
    });

    await vscode.env.openExternal(vscode.Uri.parse(prUrl));

    vscode.window.showInformationMessage(
        `✅ ${promotionBranch} pushed (already validated). Review & merge the PR (→ ${targetEnv}) in your browser — ` +
        `${targetEnv.toUpperCase()} deploys once you click Deploy in the Dashboard after it's merged.`
    );
    storyProvider.refresh();
}

/** Shows conflict guidance and offers to open the first conflicted file. */
export async function reportOperationConflict(
    gitHelper: GitHelper,
    conflicts: string[],
    label:     string
): Promise<void> {
    const list   = conflicts.slice(0, 8).join(", ") + (conflicts.length > 8 ? ", ..." : "");
    const choice = await vscode.window.showWarningMessage(
        `Conflicts while preparing ${label}:\n\n${list || "see Source Control"}\n\n` +
        `Resolve them in the editor (Source Control view), save, then run "Resume".`,
        "Open Conflicts",
        "Later"
    );

    if (choice === "Open Conflicts") {
        if (conflicts[0]) {
            const fileUri = vscode.Uri.joinPath(vscode.Uri.file(gitHelper.getWorkspaceRoot()), conflicts[0]);
            await vscode.window.showTextDocument(fileUri).then(undefined, () => {});
        }
        await vscode.commands.executeCommand("workbench.view.scm");
    }
}
