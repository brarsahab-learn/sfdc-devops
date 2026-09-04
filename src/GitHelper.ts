// GitHelper.ts
// Wraps VS Code's built-in git extension and shell commands.
// Provides clean async git operations for all commands.

import * as vscode from "vscode";
import { execFile }       from "child_process";
import { promisify }      from "util";
import * as fs            from "fs";
import * as path          from "path";
import {
    getBaseBranch, getDevBranch, featureBranchName, isFeatureBranch as isFeatureBranchName,
    promoBranchName as buildPromoBranchName, getSourceRootFolder, getRepoWorkspace, getRepoSlug,
    ResolvedEnvironment, getTicketKeyPattern, getPromotionBranchTemplate,
} from "./config";
import { IGitProviderClient } from "./GitProviderClient";
import { AuditEntry, renderAuditHtml } from "./AuditLog";
import { log, revealLog, debugLog } from "./Log";
import { storyIdFromMessage } from "./DeploymentPlanner";

const execFileAsync = promisify(execFile);

/** Result of starting or resuming a cherry-pick operation. */
export interface PromotionOutcome {
    status:    "clean" | "conflict";
    branch:    string;
    conflicts: string[];
}

/** A cherry-pick left in progress for manual conflict resolution. */
export interface PendingOp {
    kind:       "dev-publish" | "promotion";
    storyId:    string;
    targetEnv?: string;                   // promotion only
    mode?:      "validate" | "promote";   // promotion only
}


export class GitHelper {
    // Guards against two of beginPromotion/publishToDevBranch/continuePendingOperation/
    // abortPendingOperation actually running at once — e.g. a double-click, or the webview
    // and Command Palette firing the same command within the same tick. There's only one
    // working tree, so overlapping calls would interleave `git checkout`/`cherry-pick`
    // commands against it, which can corrupt it in ways "Resume" can't cleanly recover from.
    // This is in addition to (not a replacement for) conflictingPendingOperation(), which
    // handles the sequential case — one story left incomplete, a different one started later.
    private gitOperationBusy = false;

    private acquireGitLock(): void {
        if (this.gitOperationBusy) {
            throw new Error("Another promotion/publish operation is already running — wait for it to finish before starting a new one.");
        }
        this.gitOperationBusy = true;
    }

    private releaseGitLock(): void {
        this.gitOperationBusy = false;
    }

    private get workspaceRoot(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    }

    /** The workspace root every git/CLI command runs from — the single source of truth other modules should use instead of reading `vscode.workspace.workspaceFolders` directly. */
    getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    private async git(args: string[]): Promise<string> {
        debugLog(`$ git ${args.join(" ")}`);
        // Any git command that can move HEAD marks a short self-initiated window — see
        // isRecentSelfInitiatedSwitch(). One choke point instead of tagging every call site
        // individually, so it can never miss a checkout this class adds later.
        if (args[0] === "checkout" || args[0] === "switch") { this._markSelfInitiatedSwitch(); }
        try {
            const { stdout } = await execFileAsync("git", args, {
                cwd:      this.workspaceRoot,
                timeout:  30_000,
            });
            return stdout.trim();
        } catch (e: any) {
            debugLog(`$ git ${args.join(" ")} — failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    // ── Branch operations ─────────────────────────────────────────────────────

    async currentBranch(): Promise<string | null> {
        try {
            return await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
        } catch {
            return null;
        }
    }

    async createFeatureBranch(storyId: string): Promise<string> {
        const branchName = featureBranchName(storyId);

        // Always branch from the configured base branch — clean isolation (Copado-style model)
        const base = getBaseBranch();
        await this.git(["fetch", "origin"]);
        await this.git(["checkout", base]);
        await this.git(["pull", "origin", base]);

        // Create and push feature branch
        await this.git(["checkout", "-b", branchName]);
        await this.git(["push", "-u", "origin", branchName]);

        return branchName;
    }

    /**
     * Creates an environment branch (dev/qa/uat/prod/...) directly on origin, pointing at
     * wherever the configured base branch's tip currently is — Setup Check's one-click fix
     * for "this environment branch doesn't exist yet." Never touches the local checkout (no
     * `git checkout` at all): a plain ref-to-ref push, so it can't collide with uncommitted
     * work or leave the workspace on an unexpected branch.
     */
    async createEnvBranchOnOrigin(branchName: string): Promise<void> {
        const base = getBaseBranch();
        await this.git(["fetch", "origin", "--prune"]);
        if (!(await this.remoteBranchExists(base))) {
            throw new Error(`Base branch origin/${base} doesn't exist either — push that first (or fix sfDevops.baseBranch).`);
        }
        await this.git(["push", "origin", `origin/${base}:refs/heads/${branchName}`]);
    }

    // ── Pending cherry-pick state (survives reloads via a file in the git dir) ──

    private async gitDirPath(): Promise<string> {
        const dir = await this.git(["rev-parse", "--git-dir"]);
        return path.isAbsolute(dir) ? dir : path.join(this.workspaceRoot, dir);
    }

    private async pendingFilePath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-pending.json");
    }

    private async writePending(op: PendingOp): Promise<void> {
        try { fs.writeFileSync(await this.pendingFilePath(), JSON.stringify(op)); } catch { /* best effort */ }
    }

    private async clearPending(): Promise<void> {
        try { fs.rmSync(await this.pendingFilePath(), { force: true }); } catch { /* ignore */ }
    }

    private async readPending(): Promise<PendingOp | null> {
        try {
            return JSON.parse(fs.readFileSync(await this.pendingFilePath(), "utf8")) as PendingOp;
        } catch {
            return null;
        }
    }

    // ── Audit trail (local-only, per clone, in the git dir) ─────────────────────

    async auditJsonPath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-audit.json");
    }

    async auditHtmlPath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-audit.html");
    }

    private async readAuditEntries(): Promise<AuditEntry[]> {
        try {
            const parsed = JSON.parse(fs.readFileSync(await this.auditJsonPath(), "utf8"));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    /** All recorded audit entries, oldest first — used by the in-editor Audit Trail panel. */
    async getAuditEntries(): Promise<AuditEntry[]> {
        return this.readAuditEntries();
    }

    /** Appends one entry to the audit trail and regenerates the HTML view. Best-effort — never throws. */
    async appendAudit(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void> {
        try {
            const entries = await this.readAuditEntries();
            entries.push({
                ...entry,
                id:        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
            });
            fs.writeFileSync(await this.auditJsonPath(), JSON.stringify(entries, null, 2));
            fs.writeFileSync(await this.auditHtmlPath(), renderAuditHtml(entries));
        } catch { /* logging must never break the underlying operation */ }
    }

    /**
     * Removes audit entries older than `olderThanMs` milliseconds. Returns count removed.
     * Pass 0 to remove all entries.
     */
    async trimAuditLog(olderThanMs: number): Promise<number> {
        try {
            const entries = await this.readAuditEntries();
            if (entries.length === 0) { return 0; }
            const cutoff = Date.now() - olderThanMs;
            const kept = olderThanMs === 0 ? [] : entries.filter(e => {
                const ts = new Date(e.timestamp ?? 0).getTime();
                return ts >= cutoff;
            });
            if (kept.length === entries.length) { return 0; }
            const removed = entries.length - kept.length;
            fs.writeFileSync(await this.auditJsonPath(), JSON.stringify(kept, null, 2));
            fs.writeFileSync(await this.auditHtmlPath(), renderAuditHtml(kept));
            return removed;
        } catch {
            return 0;
        }
    }

    /** Returns the file size of the audit log JSON in bytes, or 0 if not present. */
    async getAuditLogSizeBytes(): Promise<number> {
        try {
            return fs.statSync(await this.auditJsonPath()).size;
        } catch {
            return 0;
        }
    }

    // ── Deployment state (local-only, per clone, in the git dir) ────────────────

    private async deployStateFilePath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-deploy-state.json");
    }

    private async readDeployState(): Promise<Record<string, { sha: string; deployedAt: string; [k: string]: any }>> {
        try {
            return JSON.parse(fs.readFileSync(await this.deployStateFilePath(), "utf8"));
        } catch {
            return {};
        }
    }

    /** The last commit this extension deployed to `envName`, if any. */
    async getDeployState(envName: string): Promise<{ sha: string; deployedAt: string } | null> {
        const data = await this.readDeployState();
        return data[envName] ?? null;
    }

    /** Records a successful deploy so future runs can diff "what changed since". Best-effort. */
    async recordDeployed(envName: string, sha: string, extra: object = {}): Promise<void> {
        const data = await this.readDeployState();
        data[envName] = { sha, deployedAt: new Date().toISOString(), ...extra };
        try {
            fs.writeFileSync(await this.deployStateFilePath(), JSON.stringify(data, null, 2));
        } catch { /* best effort */ }
    }

    /**
     * Whether `prevEnv` has anything merged onto its branch that hasn't actually been
     * deployed through the Deployment Dashboard yet — the same lastDeploy-vs-currentSha
     * comparison DeploymentDashboardPanel._buildViewModel already does for its own display,
     * answered as a yes/no gate instead of a file/commit breakdown. Callers are expected to
     * skip calling this entirely for the first promotable environment (its "previous stage"
     * is the publish env, which has no deploy concept and would otherwise always report
     * "never deployed").
     */
    async checkPrevEnvDeployed(prevEnv: ResolvedEnvironment, targetLabel?: string): Promise<{ blocked: boolean; reason?: string }> {
        const currentSha = await this.remoteHeadSha(prevEnv.branch);
        if (!currentSha) { return { blocked: false }; } // branch doesn't exist yet — nothing to gate on

        const lastDeploy = await this.getDeployState(prevEnv.name);
        if (!lastDeploy) {
            return {
                blocked: true,
                reason: `${prevEnv.label} has never been deployed from the Deployment Dashboard — deploy it first${targetLabel ? ` before promoting to ${targetLabel}` : ""}.`,
            };
        }
        if (lastDeploy.sha === currentSha) { return { blocked: false }; }

        const commits = await this.commitLogBetweenRaw(lastDeploy.sha, `origin/${prevEnv.branch}`);
        return {
            blocked: true,
            reason: `${prevEnv.label} has ${commits.length} commit(s) merged but not yet deployed — deploy it in the Deployment Dashboard${targetLabel ? ` before promoting to ${targetLabel}` : ""}.`,
        };
    }

    private async notifiedStateFilePath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-notified-state.json");
    }

    private async readNotifiedState(): Promise<Record<string, string>> {
        try {
            return JSON.parse(fs.readFileSync(await this.notifiedStateFilePath(), "utf8"));
        } catch {
            return {};
        }
    }

    /** The last SHA the background poller already raised a "pending deployment" toast for. */
    async getLastNotifiedSha(envName: string): Promise<string | null> {
        const data = await this.readNotifiedState();
        return data[envName] ?? null;
    }

    async setLastNotifiedSha(envName: string, sha: string): Promise<void> {
        const data = await this.readNotifiedState();
        data[envName] = sha;
        try {
            fs.writeFileSync(await this.notifiedStateFilePath(), JSON.stringify(data, null, 2));
        } catch { /* best effort */ }
    }

    /** Current `origin/<branch>` HEAD sha, or null if the branch doesn't exist on the remote. */
    async remoteHeadSha(branch: string): Promise<string | null> {
        try {
            return await this.git(["rev-parse", "--verify", `origin/${branch}`]);
        } catch {
            return null;
        }
    }

    /**
     * Returns unique story IDs from commits on `origin/<branch>` since `fromSha`
     * (or the last 50 commits when fromSha is not known). Used to annotate
     * deployment-pending notifications with human-readable story context.
     */
    async groupChangesByStory(branch: string, fromSha?: string): Promise<string[]> {
        try {
            const range = fromSha ? `${fromSha}..origin/${branch}` : `origin/${branch}`;
            const limitArgs = fromSha ? [] : ["-50"];
            const format = "%s";
            const raw = await this.git([
                "log", "--no-merges", ...limitArgs, `--pretty=format:${format}`, range,
            ]);
            const pattern = getTicketKeyPattern();
            const ids = new Set<string>();
            for (const msg of raw.split("\n").filter(Boolean)) {
                const id = storyIdFromMessage(msg, pattern);
                if (id) { ids.add(id); }
            }
            return [...ids];
        } catch {
            return [];
        }
    }

    /**
     * Like `commitLogBetween`, but takes raw refs with no `origin/` prefixing — needed
     * when `fromRef` is a bare commit SHA (e.g. a recorded last-deployed marker) rather
     * than a branch name. `--no-merges` for the same reason as `commitLogBetween`: a
     * "Merge pull request #N from .../promotion/{storyId}-to-{env}" commit has no file
     * list of its own (`git show --name-status` on a merge commit returns nothing without
     * `-m`) and doesn't match the story-id convention either — left in, it shows up as a
     * spurious zero-file "story" group in the Deployment Dashboard's tree/filter and as an
     * extra phantom commit in checkPrevEnvDeployed's "N commit(s) pending" count, on top of
     * the real squashed commit that already carries the actual files for that promotion.
     */
    async commitLogBetweenRaw(
        fromRef: string,
        toRef:   string
    ): Promise<{ hash: string; date: string; author: string; message: string }[]> {
        const format = "%H%x1f%aI%x1f%an%x1f%s";
        const raw = await this.git(["log", "--no-merges", `${fromRef}..${toRef}`, `--pretty=format:${format}`]);
        return raw.split("\n").filter(Boolean).map(line => {
            const [hash, date, author, message] = line.split("\x1f");
            return { hash, date, author, message };
        });
    }

    /** Merge-base commit of two remote branches — used as the "since it was cut" baseline for an environment that's never been deployed from this dashboard, so its pending tree isn't just "everything, unselectably." */
    async mergeBase(branchA: string, branchB: string): Promise<string | null> {
        try {
            return await this.git(["merge-base", `origin/${branchA}`, `origin/${branchB}`]);
        } catch {
            return null;
        }
    }

    /** Files touched by a single commit, in the same shape as `diffNameStatusBetween`. */
    async filesInCommit(sha: string): Promise<{ path: string; change: "added" | "modified" | "deleted" }[]> {
        const raw = await this.git(["show", "--name-status", "--format=", sha]);
        return raw.split("\n").filter(Boolean).map(line => {
            const tab = line.indexOf("\t");
            const code = line.slice(0, tab).trim();
            const filePath = line.slice(tab + 1).trim();
            const change: "added" | "modified" | "deleted" =
                code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
            return { path: filePath, change };
        });
    }

    /** Logs the file list a squashed commit is about to cherry-pick, so it's visible before the pick runs. */
    private async logChangedFiles(sha: string): Promise<void> {
        const files = await this.filesInCommit(sha).catch(() => []);
        if (files.length === 0) { log("No file changes found in this story's commit."); return; }
        log(`Picking up ${files.length} changed file(s):`);
        for (const f of files) { log(`  ${f.change === "added" ? "+" : f.change === "deleted" ? "-" : "~"} ${f.path}`); }
    }

    private async cherryPickInProgress(): Promise<boolean> {
        try {
            await this.git(["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Builds a single squashed commit of the story's NET changes (merge-base(base,feature)..feature)
     * on a throwaway local branch and returns its SHA. Squashing first means we cherry-pick ONE
     * ordinary commit — avoiding failures when the feature history contains merge commits or
     * commits already present in the target (e.g. after the dev merges main into their branch).
     */
    private async storySquashRef(storyId: string, base: string): Promise<string> {
        const featureBranch = featureBranchName(storyId);
        const tmpBranch     = `sf-devops-squash/${storyId}`;

        if (!(await this.remoteBranchExists(featureBranch))) {
            throw new Error(
                `Feature branch origin/${featureBranch} not found. Expected it to be pushed under this name ` +
                `for story "${storyId}" — check that the branch was created via Start New Story and pushed.`
            );
        }

        const mergeBase = await this.git(["merge-base", `origin/${base}`, `origin/${featureBranch}`]);

        await this.git(["checkout", "-B", tmpBranch, `origin/${featureBranch}`]);
        await this.git(["reset", "--soft", mergeBase]);
        try {
            await this.git(["-c", "core.editor=true", "commit", "--no-verify", "-m", `${storyId}: consolidated story changes`]);
        } catch {
            throw new Error(`No changes found for ${storyId} relative to ${base}.`);
        }
        return this.git(["rev-parse", "HEAD"]);
    }

    private async deleteSquashRef(storyId: string): Promise<void> {
        await this.git(["branch", "-D", `sf-devops-squash/${storyId}`]).catch(() => {});
    }

    /**
     * Read-only preview of exactly what a promotion would carry — the same
     * merge-base(base, featureBranch)..featureBranch range `storySquashRef` squashes into a
     * commit, but as a plain diff with no checkout, no commit, no mutation of any kind. Lets
     * the Promote flow show "here's what's about to go out" and get an explicit confirm
     * BEFORE `beginPromotion` does anything real, instead of the file list only surfacing in
     * the log after the cherry-pick has already started.
     */
    async previewStoryFiles(storyId: string): Promise<{ path: string; change: "added" | "modified" | "deleted" }[]> {
        const featureBranch = featureBranchName(storyId);
        const base = getBaseBranch();

        if (!(await this.remoteBranchExists(featureBranch))) {
            throw new Error(
                `Feature branch origin/${featureBranch} not found. Expected it to be pushed under this name ` +
                `for story "${storyId}" — check that the branch was created via Start New Story and pushed.`
            );
        }

        const mb = await this.mergeBase(base, featureBranch);
        if (!mb) { return []; }

        const raw = await this.git(["diff", "--name-status", mb, `origin/${featureBranch}`]);
        return raw.split("\n").filter(Boolean).map(line => {
            const tab = line.indexOf("\t");
            const code = line.slice(0, tab).trim();
            const filePath = line.slice(tab + 1).trim();
            const change: "added" | "modified" | "deleted" =
                code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
            return { path: filePath, change };
        });
    }

    /**
     * True if the story's CURRENT content (its net diff vs base, same set `previewStoryFiles`
     * returns) is already fully reflected on `envBranch` for those exact files. Used to catch
     * a real gap in the pipeline status: once a story has been promoted all the way through,
     * publishing NEW changes to the feature branch (more commits, another Commit & Publish)
     * used to leave every later stage still showing "Deployed"/"Merged" from the OLD content —
     * storyCommitShaOnBranch just finds *some* commit for this story on that branch, it has no
     * idea a newer one now exists on the feature branch that was never re-promoted. Returns
     * true (nothing to compare) when there's no feature branch or no story files to check —
     * absence of a gap, not a false "up to date."
     */
    async storyContentMatchesBranch(storyId: string, envBranch: string): Promise<boolean> {
        const featureBranch = featureBranchName(storyId);
        if (!(await this.remoteBranchExists(featureBranch))) { return true; }
        const files = await this.previewStoryFiles(storyId).catch(() => []);
        if (files.length === 0) { return true; }
        const diff = await this.git(["diff", "--name-status", `origin/${envBranch}`, `origin/${featureBranch}`, "--", ...files.map(f => f.path)]);
        return diff.trim().length === 0;
    }

    /** Validate Only pushes the validate-branch template; Promote & Deploy pushes the promotion-branch template (the PR source). */
    promoBranchName(storyId: string, targetEnv: string, mode: "validate" | "promote"): string {
        return buildPromoBranchName(storyId, targetEnv, mode);
    }

    /**
     * Commit & Publish: applies the story's squashed net changes straight onto the dev
     * branch and pushes it — no PR, no Dev org deploy.
     * On conflict the cherry-pick is LEFT in place for resolve-and-resume.
     */
    async publishToDevBranch(storyId: string, force: boolean = false): Promise<PromotionOutcome> {
        this.acquireGitLock();
        try {
            const base      = getBaseBranch();
            const devBranch = getDevBranch();

            revealLog(`Publishing ${storyId} → ${devBranch}`);

            await this.git(["fetch", "origin", "--prune"]);
            try {
                await this.git(["rev-parse", "--verify", `origin/${devBranch}`]);
            } catch {
                throw new Error(`${devBranch} branch not found on remote (origin/${devBranch}).`);
            }

            const conflicting = await this.conflictingPendingOperation(storyId);
            if (conflicting) {
                if (!force) {
                    throw new Error(
                        `Another operation is still pending for ${conflicting.storyId}` +
                        `${conflicting.targetEnv ? ` → ${conflicting.targetEnv}` : ""} (unresolved conflict). ` +
                        `Resolve or discard it before starting a new one.`
                    );
                }
                await this.abortPendingOperationImpl(conflicting.storyId);
            }

            await this.git(["cherry-pick", "--abort"]).catch(() => {});
            const squashSha = await this.storySquashRef(storyId, base);
            await this.logChangedFiles(squashSha);
            await this.git(["checkout", "-B", devBranch, `origin/${devBranch}`]);
            await this.writePending({ kind: "dev-publish", storyId });

            try {
                await this.git(["-c", "core.editor=true", "cherry-pick", squashSha]);
                log("Applied cleanly.");
            } catch {
                const conflicts = await this.unmergedFiles();
                if (conflicts.length === 0) {
                    // Story already present in dev → finish the no-op cherry-pick.
                    await this.git(["cherry-pick", "--skip"]).catch(() => {});
                    log("Already up to date in dev — nothing new to apply.");
                } else {
                    log(`Conflicts in ${conflicts.length} file(s) — resolve them, then click Resume.`);
                    return { status: "conflict", branch: devBranch, conflicts };
                }
            }

            await this.completeDevPublish(storyId);
            log(`Published to ${devBranch}.`);
            return { status: "clean", branch: devBranch, conflicts: [] };
        } finally {
            this.releaseGitLock();
        }
    }

    /** After a clean dev-publish cherry-pick: push the dev branch, clear state, return to feature. */
    async completeDevPublish(storyId: string): Promise<void> {
        const devBranch = getDevBranch();
        await this.git(["push", "origin", devBranch]);
        await this.deleteSquashRef(storyId);
        await this.clearPending();
        await this.checkoutFeature(storyId);
    }

    /**
     * Starts a promotion (validate or promote): creates the promotion branch cut from
     * the target env branch and cherry-picks the story's squashed commit onto it.
     * On conflict the cherry-pick is LEFT in place for resolve-and-resume.
     */
    /**
     * `targetEnv` is the environment's logical name (used for labeling/gating/audit);
     * `targetBranch` is the actual git branch to cut from — pass `findEnvironment(targetEnv)?.branch`,
     * since an environment's name and branch can now differ (e.g. "prod" → branch "main").
     */
    async beginPromotion(
        storyId:      string,
        targetEnv:    string,
        mode:         "validate" | "promote",
        targetBranch: string = targetEnv,
        force:        boolean = false
    ): Promise<PromotionOutcome> {
        this.acquireGitLock();
        try {
            const featureBranch   = featureBranchName(storyId);
            // Validate and Promote now share ONE branch ("promotion", never the separate
            // "validate" template) — mandatory validation means Validate is just an earlier
            // step in the same sequence Promote finishes, not a parallel path with its own
            // branch. `mode` still matters below for what gets written to pending state (so
            // Resume knows the ORIGINAL user intent) and for tag-on-promote in finalizePromotion.
            const promotionBranch = this.promoBranchName(storyId, targetEnv, "promote");
            const base   = getBaseBranch();

            const envLabel = targetBranch === targetEnv ? targetEnv : `${targetEnv} (branch: ${targetBranch})`;
            revealLog(`${mode === "validate" ? "Validating" : "Promoting"} ${storyId} → ${envLabel}`);

            await this.git(["fetch", "origin", "--prune"]);
            try {
                await this.git(["rev-parse", "--verify", `origin/${featureBranch}`]);
            } catch {
                throw new Error(`Source branch not found on remote: ${featureBranch}. Push the feature branch first.`);
            }
            try {
                await this.git(["rev-parse", "--verify", `origin/${targetBranch}`]);
            } catch {
                throw new Error(`Target environment branch not found: origin/${targetBranch}.`);
            }

            const conflicting = await this.conflictingPendingOperation(storyId, targetEnv);
            if (conflicting) {
                if (!force) {
                    throw new Error(
                        `Another operation is still pending for ${conflicting.storyId}` +
                        `${conflicting.targetEnv ? ` → ${conflicting.targetEnv}` : ""} (unresolved conflict). ` +
                        `Resolve or discard it before starting a new one.`
                    );
                }
                await this.abortPendingOperationImpl(conflicting.storyId);
            }

            await this.git(["cherry-pick", "--abort"]).catch(() => {});
            const squashSha = await this.storySquashRef(storyId, base);
            await this.logChangedFiles(squashSha);
            // Copado model: cut every promotion branch from its own target env branch.
            await this.git(["checkout", "-B", promotionBranch, `origin/${targetBranch}`]);
            await this.writePending({ kind: "promotion", storyId, targetEnv, mode });

            try {
                await this.git(["-c", "core.editor=true", "cherry-pick", squashSha]);
                log("Applied cleanly.");
                return { status: "clean", branch: promotionBranch, conflicts: [] };
            } catch {
                const conflicts = await this.unmergedFiles();
                if (conflicts.length === 0) {
                    // Story already present in the target → finish the no-op cherry-pick.
                    await this.git(["cherry-pick", "--skip"]).catch(() => {});
                    log(`Already up to date in ${targetEnv} — nothing new to apply.`);
                    return { status: "clean", branch: promotionBranch, conflicts: [] };
                }
                log(`Conflicts in ${conflicts.length} file(s) — resolve them, then click Resume.`);
                return { status: "conflict", branch: promotionBranch, conflicts };
            }
        } finally {
            this.releaseGitLock();
        }
    }

    /**
     * Continues the pending cherry-pick after conflicts are resolved.
     * Returns "conflict" again if a later commit still conflicts.
     */
    async continuePendingOperation(): Promise<PromotionOutcome> {
        this.acquireGitLock();
        try {
            const branch = (await this.currentBranch()) ?? "";

            const unmerged = await this.unmergedFiles();
            if (unmerged.length > 0) {
                return { status: "conflict", branch, conflicts: unmerged };
            }

            await this.git(["add", "-A"]);
            const staged = await this.git(["diff", "--cached", "--name-only"]).catch(() => "");

            try {
                const op = staged ? "--continue" : "--skip";
                await this.git(["-c", "core.editor=true", "cherry-pick", op]);
                return { status: "clean", branch, conflicts: [] };
            } catch {
                const conflicts = await this.unmergedFiles();
                return { status: "conflict", branch, conflicts };
            }
        } finally {
            this.releaseGitLock();
        }
    }

    /** Aborts the pending cherry-pick and returns to the feature branch. */
    async abortPendingOperation(storyId: string): Promise<void> {
        this.acquireGitLock();
        try {
            await this.abortPendingOperationImpl(storyId);
        } finally {
            this.releaseGitLock();
        }
    }

    /** Unlocked — only call this from within a method that already holds the git lock. */
    private async abortPendingOperationImpl(storyId: string): Promise<void> {
        await this.git(["cherry-pick", "--abort"]).catch(() => {});
        await this.deleteSquashRef(storyId);
        await this.clearPending();
        await this.checkoutFeature(storyId);
    }

    /** Reads the pending operation (a cherry-pick left mid-conflict), if any. */
    async getPendingOperation(): Promise<PendingOp | null> {
        const op = await this.readPending();
        if (!op) { return null; }
        if (!(await this.cherryPickInProgress())) {
            await this.clearPending();  // stale marker
            return null;
        }
        return op;
    }

    /**
     * There's only ever one working tree, so only one cherry-pick can truly be "in
     * progress" at a time — but that pending op can belong to a DIFFERENT story/env than
     * the one about to start. beginPromotion/publishToDevBranch used to just silently
     * `cherry-pick --abort` whatever was there, discarding another story's unresolved
     * conflict with no warning. Callers should check this first and let the user decide
     * before starting an operation that would blow that away.
     */
    async conflictingPendingOperation(storyId: string, targetEnv?: string): Promise<PendingOp | null> {
        const existing = await this.getPendingOperation();
        if (!existing) { return null; }
        const sameOperation = existing.storyId === storyId && existing.targetEnv === targetEnv;
        return sameOperation ? null : existing;
    }

    /**
     * Tags (promote only) and pushes the completed branch.
     * Call after `beginPromotion`/`continuePendingOperation` returns "clean".
     */
    async finalizePromotion(
        storyId:   string,
        targetEnv: string,
        mode:      "validate" | "promote"
    ): Promise<{ branch: string; tag: string }> {
        const promotionBranch = this.promoBranchName(storyId, targetEnv, "promote"); // unified branch — see beginPromotion
        const date            = new Date().toISOString().slice(0, 10);
        const tag             = `promo/${storyId}-to-${targetEnv}-${date}`;

        if (mode === "promote") {
            try {
                await this.git(["tag", tag, "-m", `Promotion: ${storyId} to ${targetEnv} on ${date}`]);
            } catch {
                // Tag may already exist locally — non-fatal
            }
        }

        await this.git(["push", "--force-with-lease", "origin", promotionBranch]);

        if (mode === "promote") {
            try {
                await this.git(["push", "origin", tag]);
            } catch {
                // Tag may already exist on remote — non-fatal
            }
        }

        await this.deleteSquashRef(storyId);
        await this.clearPending();
        return { branch: promotionBranch, tag };
    }

    /** True if the promotion branch already exists on the remote (for Copado reuse). */
    async promotionBranchExists(storyId: string, targetEnv: string): Promise<boolean> {
        await this.fetchRemote();
        return this.remoteBranchExists(buildPromoBranchName(storyId, targetEnv, "promote"));
    }

    // ── Mandatory promotion-validation gate (per story + environment, in the git dir) ──
    // "Promote" is never allowed to open a PR without this having actually passed for the
    // promotion branch's CURRENT content — see runPromotion() in promoteStory.ts. Same
    // sha-fingerprinted "stale invalidates" shape as the coverage gate above: the record only
    // counts while the promotion branch is still at the exact sha it was validated at.

    private async promotionValidationFilePath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-promotion-validation.json");
    }

    private async readPromotionValidation(): Promise<Record<string, any>> {
        try {
            return JSON.parse(fs.readFileSync(await this.promotionValidationFilePath(), "utf8"));
        } catch {
            return {};
        }
    }

    async isPromotionValidated(storyId: string, targetEnv: string): Promise<boolean> {
        const data = await this.readPromotionValidation();
        const entry = data[`${storyId}::${targetEnv}`];
        if (!entry?.passed) { return false; }
        const currentSha = await this.remoteHeadSha(this.promoBranchName(storyId, targetEnv, "promote"));
        return Boolean(currentSha) && currentSha === entry.branchSha;
    }

    async recordPromotionValidated(storyId: string, targetEnv: string, details: object = {}): Promise<void> {
        const data = await this.readPromotionValidation();
        const branchSha = await this.remoteHeadSha(this.promoBranchName(storyId, targetEnv, "promote"));
        data[`${storyId}::${targetEnv}`] = { passed: true, branchSha, ...details, date: new Date().toISOString() };
        try {
            fs.writeFileSync(await this.promotionValidationFilePath(), JSON.stringify(data, null, 2));
        } catch { /* best effort */ }
    }

    /** The raw validation record (including WHEN it passed), regardless of whether it's still fresh for the branch's current sha — used by the Story Progress timeline to show "validated at {date}" even if the branch has since moved and the gate itself has re-locked. */
    async getPromotionValidationRecord(storyId: string, targetEnv: string): Promise<{ passed: boolean; date?: string } | null> {
        const data = await this.readPromotionValidation();
        const entry = data[`${storyId}::${targetEnv}`];
        return entry ? { passed: Boolean(entry.passed), date: entry.date } : null;
    }

    /** Deletes a promotion branch, remote then local — used for the post-deploy cleanup prompt. Best-effort: a branch that's already gone (or was never fetched locally) isn't an error here. */
    async deletePromotionBranch(storyId: string, targetEnv: string): Promise<void> {
        const branch = this.promoBranchName(storyId, targetEnv, "promote");
        await this.git(["push", "origin", "--delete", branch]).catch(() => {});
        await this.git(["branch", "-D", branch]).catch(() => {});
    }

    /**
     * Best-effort: fast-forwards the LOCAL ref for `branch` to match `origin/<branch>`,
     * without checking it out or touching anything else — "pull it on local" / "keep the
     * promotion branch updated on local" as a passive convenience, so the branch is already
     * current whenever you do switch to it, instead of looking stale from before a merge.
     * Never rewrites local history: a fetch into a non-checked-out branch ref is refused by
     * git unless it's a fast-forward, and the checked-out case only merges when the working
     * tree is clean. Silently does nothing if the branch doesn't exist locally yet, is
     * checked out with uncommitted changes, or has diverged (never forces past that).
     */
    async syncLocalRef(branch: string): Promise<void> {
        try {
            const hasLocal = await this.git(["branch", "--list", branch]).then(out => out.trim().length > 0);
            if (!hasLocal) { return; }
            if ((await this.currentBranch()) === branch) {
                if (!(await this.hasUncommittedChanges())) {
                    await this.git(["merge", "--ff-only", `origin/${branch}`]).catch(() => {});
                }
                return;
            }
            await this.git(["fetch", "origin", `${branch}:${branch}`]).catch(() => {});
        } catch { /* best effort */ }
    }

    /** Keeps every promotion branch that already exists locally current, ground-rule style — a promotion branch you're tracking should never look stale just because someone else pushed to it. Best-effort, run periodically (see extension.ts's poller). */
    async syncLocalPromotionBranches(): Promise<void> {
        try {
            const prefix = getPromotionBranchTemplate().split("{")[0];
            const out = await this.git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}*`]);
            for (const branch of out.split("\n").filter(Boolean)) {
                await this.syncLocalRef(branch);
            }
        } catch { /* best effort */ }
    }

    /**
     * Finds the commit on `origin/<branch>` whose message resolves to EXACTLY `storyId` —
     * not just any commit whose message happens to contain that text. `git log --grep` on
     * its own is a substring/regex search: it would treat "." in a free-text story id as a
     * regex wildcard, and "TEST-1" would false-positive match "TEST-10"'s commit. `--grep
     * --fixed-strings` fixes the first problem (literal, not regex); to fix the second,
     * `--grep` here is only used as a fast git-native pre-filter — every candidate line is
     * then re-checked by extracting its story id the same structured way
     * `distinctStoryIdsFromCommits` does (`storyIdFromMessage`) and comparing for exact
     * equality, so a prefix collision can never produce a wrong match.
     */
    private async findStoryCommit(branch: string, storyId: string): Promise<string | null> {
        try {
            const out = await this.git(["log", `origin/${branch}`, "--fixed-strings", "--grep", storyId, "--format=%H%x1f%s"]);
            const pattern = getTicketKeyPattern();
            for (const line of out.split("\n")) {
                if (!line) { continue; }
                const sepIdx = line.indexOf("\x1f");
                const hash = line.slice(0, sepIdx);
                const message = line.slice(sepIdx + 1);
                if (storyIdFromMessage(message, pattern) === storyId) { return hash; }
            }
            return null;
        } catch {
            return null;
        }
    }

    /** True if `origin/<branch>` has a commit whose message resolves to exactly the story id. */
    async branchContainsStory(branch: string, storyId: string): Promise<boolean> {
        return (await this.findStoryCommit(branch, storyId)) !== null;
    }

    /** The SHA of the commit on `origin/<branch>` whose message resolves to exactly the story id, or null if there isn't one. */
    async storyCommitShaOnBranch(branch: string, storyId: string): Promise<string | null> {
        return this.findStoryCommit(branch, storyId);
    }

    /** True if `ancestorSha` is contained in (or equal to) `descendantSha`'s history — i.e. it was already deployed as part of that commit. */
    async isAncestorSha(ancestorSha: string, descendantSha: string): Promise<boolean> {
        try {
            await this.git(["merge-base", "--is-ancestor", ancestorSha, descendantSha]);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Apex class/trigger names changed in the feature branch vs the base branch,
     * excluding test classes (names containing "Test"). These are the classes whose
     * coverage the gate checks.
     */
    async featureApexClasses(storyId: string): Promise<string[]> {
        const base       = getBaseBranch();
        const sourceRoot = getSourceRootFolder();
        await this.git(["fetch", "origin", "--prune"]).catch(() => {});

        let out = "";
        try {
            out = await this.git(["diff", "--name-only", `origin/${base}...origin/${featureBranchName(storyId)}`]);
        } catch {
            return [];
        }

        const names = (out ? out.split("\n") : [])
            .filter(Boolean)
            .filter(f => f.includes(sourceRoot) && /\.(cls|trigger)$/i.test(f))
            .map(f => f.split("/").pop()!.replace(/\.(cls|trigger)$/i, ""))
            .filter(n => !/(^test|tests?$)/i.test(n));   // drop test classes

        return Array.from(new Set(names));
    }

    // ── One-time coverage gate marker (per story, in the git dir) ──────────────

    private async coverageFilePath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-coverage.json");
    }

    private async readCoverage(): Promise<Record<string, any>> {
        try {
            return JSON.parse(fs.readFileSync(await this.coverageFilePath(), "utf8"));
        } catch {
            return {};
        }
    }

    /**
     * True only if coverage passed AND the feature branch hasn't moved since — updating
     * either the class under test or the test class itself pushes a new commit, which
     * changes this SHA and correctly re-locks the gate instead of trusting a stale pass.
     * Records from before this check existed have no featureBranchSha — treated as still
     * passed rather than retroactively re-locking every story that already cleared the gate.
     */
    async isCoveragePassed(storyId: string): Promise<boolean> {
        const data = await this.readCoverage();
        const entry = data[storyId];
        if (!entry?.passed) { return false; }
        if (!entry.featureBranchSha) { return true; }
        const currentSha = await this.remoteHeadSha(featureBranchName(storyId));
        return currentSha === entry.featureBranchSha;
    }

    async recordCoveragePassed(storyId: string, details: object): Promise<void> {
        const data = await this.readCoverage();
        const featureBranchSha = await this.remoteHeadSha(featureBranchName(storyId));
        data[storyId] = { passed: true, featureBranchSha, ...details, date: new Date().toISOString() };
        try {
            fs.writeFileSync(await this.coverageFilePath(), JSON.stringify(data, null, 2));
        } catch { /* best effort */ }
    }

    /** True if coverage passed before but the feature branch has since moved (a class or its test class changed) — used only to tell the Coverage panel "you already passed this once" apart from "you've never run it." */
    async isCoverageStale(storyId: string): Promise<boolean> {
        const data = await this.readCoverage();
        const entry = data[storyId];
        if (!entry?.passed || !entry.featureBranchSha) { return false; }
        const currentSha = await this.remoteHeadSha(featureBranchName(storyId));
        return currentSha !== entry.featureBranchSha;
    }

    // ── Manual sign-off gate marker (per story + environment, in the git dir) ───
    // Generalizes to any environment with sfDevops.environments[].signoffGate set —
    // e.g. QA sign-off before promoting to UAT, then UAT sign-off before whatever's next.

    private async signoffFilePath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-signoff.json");
    }

    private async readSignoff(): Promise<Record<string, any>> {
        try {
            return JSON.parse(fs.readFileSync(await this.signoffFilePath(), "utf8"));
        } catch {
            return {};
        }
    }

    private signoffKey(storyId: string, envName: string): string {
        return `${storyId}:${envName}`;
    }

    async isSignoffPassed(storyId: string, envName: string): Promise<boolean> {
        const data = await this.readSignoff();
        return Boolean(data[this.signoffKey(storyId, envName)]?.passed);
    }

    async recordSignoff(storyId: string, envName: string, details: object): Promise<void> {
        const data = await this.readSignoff();
        data[this.signoffKey(storyId, envName)] = { passed: true, ...details, date: new Date().toISOString() };
        try {
            fs.writeFileSync(await this.signoffFilePath(), JSON.stringify(data, null, 2));
        } catch { /* best effort */ }
    }

    // ── Deletion acknowledgement gate (per story + environment, in the git dir) ───
    // Records that the developer has manually handled a set of deleted metadata
    // components for a given story/env at a specific feature branch SHA.
    // The SHA is used to invalidate the ack when the feature branch advances.

    // ── Inactive-story registry ──────────────────────────────────────────────

    private async inactiveStoriesFilePath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-inactive-stories.json");
    }

    /** Returns the set of story IDs the user has explicitly marked as inactive. */
    async getInactiveStories(): Promise<Set<string>> {
        try {
            const raw = fs.readFileSync(await this.inactiveStoriesFilePath(), "utf8");
            const arr = JSON.parse(raw);
            return new Set(Array.isArray(arr) ? arr : []);
        } catch {
            return new Set();
        }
    }

    // Promise chain used as a mutex: all writes are serialized so concurrent rapid
    // clicks (mark-inactive on two cards) never interleave their read-modify-write.
    private _inactiveWriteLock = Promise.resolve();

    private _updateInactiveStories(fn: (set: Set<string>) => void): Promise<void> {
        this._inactiveWriteLock = this._inactiveWriteLock.then(async () => {
            const inactive = await this.getInactiveStories();
            fn(inactive);
            fs.writeFileSync(await this.inactiveStoriesFilePath(), JSON.stringify([...inactive], null, 2));
        });
        return this._inactiveWriteLock;
    }

    async markStoryInactive(storyId: string): Promise<void> {
        return this._updateInactiveStories(set => set.add(storyId));
    }

    async markStoryActive(storyId: string): Promise<void> {
        return this._updateInactiveStories(set => set.delete(storyId));
    }

    // ── Deletion-ack registry ─────────────────────────────────────────────────

    private async deletionAckFilePath(): Promise<string> {
        return path.join(await this.gitDirPath(), "sf-devops-deletion-ack.json");
    }

    private async readDeletionAcks(): Promise<Record<string, { sha: string }>> {
        try {
            return JSON.parse(fs.readFileSync(await this.deletionAckFilePath(), "utf8")) as Record<string, { sha: string }>;
        } catch {
            return {};
        }
    }

    private async writeDeletionAcks(data: Record<string, { sha: string }>): Promise<void> {
        try {
            fs.writeFileSync(await this.deletionAckFilePath(), JSON.stringify(data, null, 2));
        } catch { /* best effort */ }
    }

    async getDeletionAcknowledgement(storyId: string, env: string): Promise<{ sha: string } | null> {
        const key = `${storyId}::${env}`;
        return (await this.readDeletionAcks())[key] ?? null;
    }

    async setDeletionAcknowledgement(storyId: string, env: string, sha: string): Promise<void> {
        const key = `${storyId}::${env}`;
        const data = await this.readDeletionAcks();
        data[key] = { sha };
        await this.writeDeletionAcks(data);
    }

    async clearDeletionAcknowledgement(storyId: string, env: string): Promise<void> {
        const key = `${storyId}::${env}`;
        const data = await this.readDeletionAcks();
        delete data[key];
        await this.writeDeletionAcks(data);
    }

    /** Files with unresolved merge conflicts. */
    async unmergedFiles(): Promise<string[]> {
        try {
            const out = await this.git(["diff", "--name-only", "--diff-filter=U"]);
            return out ? out.split("\n").filter(Boolean) : [];
        } catch {
            return [];
        }
    }

    /** Switches back to the story's feature branch (e.g. after an operation completes). */
    async checkoutFeature(storyId: string): Promise<void> {
        await this.git(["checkout", featureBranchName(storyId)]).catch(() => {});
    }

    async commitAndPush(message: string): Promise<void> {
        await this.git(["add", "."]);
        const status = await this.git(["status", "--porcelain"]);
        if (!status) { throw new Error("No changes to commit."); }
        await this.git(["commit", "-m", message]);
        const branch = await this.currentBranch();
        if (branch) { await this.git(["push", "origin", branch]); }
    }

    /** Files currently staged in the index. */
    async stagedFiles(): Promise<string[]> {
        const out = await this.git(["diff", "--cached", "--name-only"]);
        return out ? out.split("\n").filter(Boolean) : [];
    }

    /** Commits the already-staged changes (if any) and pushes the current feature branch. */
    async commitStagedAndPushFeature(message: string): Promise<void> {
        if ((await this.stagedFiles()).length > 0) {
            await this.git(["commit", "-m", message]);
        }
        const branch = await this.currentBranch();
        if (branch) { await this.git(["push", "origin", branch]); }
    }

    async pushOnly(): Promise<void> {
        const branch = await this.currentBranch();
        if (branch) { await this.git(["push", "origin", branch]); }
    }

    async unpushedCommitCount(): Promise<number> {
        try {
            const branch = await this.currentBranch();
            if (!branch) { return 0; }
            const out = await this.git(["rev-list", "--count", `origin/${branch}..HEAD`]);
            return parseInt(out, 10) || 0;
        } catch {
            return 0;
        }
    }

    async syncWithDev(): Promise<void> {
        const branch = await this.currentBranch();
        if (!branch) { throw new Error("Not on a branch"); }

        await this.git(["fetch", "origin"]);

        const base2 = getBaseBranch();
        try {
            // Try rebase first (cleaner history)
            await this.git(["rebase", `origin/${base2}`]);
            await this.git(["push", "--force-with-lease", "origin", branch]);
        } catch (rebaseErr) {
            // Abort rebase on conflict
            try { await this.git(["rebase", "--abort"]); } catch {}
            throw new Error(
                `Sync failed due to conflicts. Resolve manually:\n  git rebase origin/${base2}\n  (fix conflicts)\n  git rebase --continue`
            );
        }
    }

    // ── Branch status ─────────────────────────────────────────────────────────

    async commitsBehind(branch: string, ref: string): Promise<number> {
        try {
            const out = await this.git(["rev-list", "--count", `${branch}..${ref}`]);
            return parseInt(out, 10) || 0;
        } catch {
            return 0;
        }
    }

    /** Refreshes remote-tracking refs so branch/merge checks are current. */
    async fetchRemote(): Promise<void> {
        try { await this.git(["fetch", "origin", "--prune"]); } catch { /* offline — use cached refs */ }
    }

    /** True if `origin/<ref>` exists. */
    async remoteBranchExists(ref: string): Promise<boolean> {
        try {
            await this.git(["rev-parse", "--verify", "--quiet", `origin/${ref}`]);
            return true;
        } catch {
            return false;
        }
    }

    /** True if every commit of `origin/<ancestor>` is contained in `origin/<descendant>` (i.e. it was merged). */
    async isMergedInto(ancestor: string, descendant: string): Promise<boolean> {
        try {
            await this.git(["merge-base", "--is-ancestor", `origin/${ancestor}`, `origin/${descendant}`]);
            return true;
        } catch {
            return false;
        }
    }

    /** Commits on the current branch that are ahead of `ref` (i.e. real story changes). */
    async commitsAhead(ref: string): Promise<number> {
        try {
            const branch = await this.currentBranch();
            if (!branch) { return 0; }
            const out = await this.git(["rev-list", "--count", `${ref}..${branch}`]);
            return parseInt(out, 10) || 0;
        } catch {
            return 0;
        }
    }

    async hasUncommittedChanges(): Promise<boolean> {
        const out = await this.git(["status", "--porcelain"]);
        return out.length > 0;
    }

    /**
     * Stashes whatever's currently uncommitted (including untracked files), labeled so it
     * can be found and restored later by `restoreStash`. Returns false (no-op) if there was
     * nothing to stash. Callers are expected to have already committed anything they DO want
     * published first — by the time this runs, everything remaining in the working tree is
     * assumed to be "not part of this operation" and gets set aside, not swept in.
     */
    async stashUnstagedChanges(label: string): Promise<boolean> {
        const out = await this.git(["stash", "push", "--include-untracked", "-m", label]);
        return !/No local changes to save/i.test(out);
    }

    /** The stash entry (e.g. "stash@{0}") most recently pushed under the given label, or null if none exists. */
    private async findStashByLabel(label: string): Promise<string | null> {
        const out = await this.git(["stash", "list", "--format=%gd %s"]).catch(() => "");
        for (const line of out ? out.split("\n") : []) {
            if (line.includes(label)) { return line.split(" ")[0] || null; }
        }
        return null;
    }

    /**
     * Restores a stash previously created by `stashUnstagedChanges`. Never silently drops
     * work: if the pop hits a conflict, git itself leaves the stash entry in place (it only
     * removes a stash on a clean pop) — this just reports that back so the caller can tell
     * the user exactly what to do, instead of pretending the restore succeeded.
     */
    async restoreStash(label: string): Promise<{ status: "restored" | "conflict" | "not-found"; ref?: string }> {
        const ref = await this.findStashByLabel(label);
        if (!ref) { return { status: "not-found" }; }
        try {
            await this.git(["stash", "pop", ref]);
            return { status: "restored" };
        } catch {
            return { status: "conflict", ref };
        }
    }

    async changedFiles(): Promise<string[]> {
        const base = getBaseBranch();
        const out = await this.git(["diff", "--name-only", `origin/${base}...HEAD`, "--diff-filter=ACMRD"]);
        return out ? out.split("\n").filter(Boolean) : [];
    }

    /** Returns all locally modified/new files (staged + unstaged) */
    async workingTreeFiles(): Promise<string[]> {
        const out = await this.git(["status", "--porcelain"]);
        return out
            ? out.split("\n")
                .filter(Boolean)
                .map(line => line.slice(3).trim())  // strip status prefix (" M ", "?? " etc)
            : [];
    }

    /** Lists all local + remote feature branches for the Resume Story picker */
    async listFeatureBranches(): Promise<string[]> {
        await this.git(["fetch", "--prune"]);
        const out = await this.git(["branch", "-a", "--format=%(refname:short)"]);
        return out
            .split("\n")
            .filter(Boolean)
            .map(b => b.replace(/^origin\//, "").trim())
            .filter(b => isFeatureBranchName(b))
            .filter((b, i, arr) => arr.indexOf(b) === i)  // deduplicate
            .sort();
    }

    /** Lists all remote feature branches (origin only). Fetches first to pick up newly-pushed branches. */
    async listRemoteFeatureBranches(): Promise<string[]> {
        try {
            await this.git(["fetch", "origin", "--prune"]);
            const out = await this.git(["branch", "-r", "--format=%(refname:short)"]);
            return out
                .split("\n")
                .filter(Boolean)
                .map(b => b.replace(/^origin\//, "").trim())
                .filter(b => isFeatureBranchName(b))
                .sort();
        } catch {
            return [];
        }
    }

    /** ISO 8601 timestamp of the most recent commit on `origin/<branch>`, or null if the branch doesn't exist. */
    async branchLastCommitTimestamp(branch: string): Promise<string | null> {
        try {
            return await this.git(["log", "-1", "--pretty=format:%aI", `origin/${branch}`]);
        } catch {
            return null;
        }
    }

    /** Last `count` commits on `origin/<branch>`, newest first. Safe for branches with fewer commits than `count`. */
    async recentCommitsOnBranch(
        branch: string,
        count = 300
    ): Promise<{ hash: string; date: string; author: string; message: string }[]> {
        try {
            const format = "%H%x1f%aI%x1f%an%x1f%s";
            const raw = await this.git(["log", "--no-merges", `-n`, String(count), `--pretty=format:${format}`, `origin/${branch}`]);
            return raw.split("\n").filter(Boolean).map(line => {
                const [hash, date, author, message] = line.split("\x1f");
                return { hash, date, author, message };
            });
        } catch {
            return [];
        }
    }

    /** Days since the last commit on `origin/<branch>` (fractional), or null if the branch has no commits / doesn't exist. */
    async branchAgeDays(branch: string): Promise<number | null> {
        const ts = await this.branchLastCommitTimestamp(branch);
        if (!ts) { return null; }
        return (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60 * 24);
    }

    /** Checks out an existing branch */
    /**
     * Checks out a branch — creating it from `origin/<branch>` first if it doesn't exist
     * locally yet. This used to try a plain `checkout` and fall back to `checkout -b` on
     * ANY failure — but a plain checkout also fails when uncommitted local changes would be
     * overwritten, and `-b` on a branch name that already exists locally then fails too
     * (uncaught), silently swallowing the real error. Checking existence explicitly means a
     * genuine conflict now surfaces as one clear error instead of a confusing second one.
     */
    async checkoutBranch(branch: string): Promise<void> {
        await this.git(["fetch", "origin"]);
        const existsLocally = await this.git(["branch", "--list", branch])
            .then(out => out.trim().length > 0)
            .catch(() => false);
        if (existsLocally) {
            await this.git(["checkout", branch]);
        } else {
            await this.git(["checkout", "-b", branch, `origin/${branch}`]);
        }
    }

    /**
     * Marks the next few seconds as "this extension just moved HEAD itself" — set
     * automatically by `git()` on every `checkout`/`switch` call (Resume/Start Story, Promote,
     * Sync, the Dashboard's temporary checkout-and-restore all go through it), so GitWatcher's
     * "you switched branches externally" banner only fires for a branch change it DIDN'T
     * cause. A time window rather than a wrapped-callback flag: the built-in git extension's
     * own state refresh (what actually fires the change event GitWatcher listens to) lags
     * slightly behind our raw `git` CLI calls, so "still true a moment after the call returns"
     * is the part that actually matters here.
     */
    private _selfInitiatedUntil = 0;
    private _markSelfInitiatedSwitch(): void {
        this._selfInitiatedUntil = Date.now() + 3000;
    }
    isRecentSelfInitiatedSwitch(): boolean {
        return Date.now() < this._selfInitiatedUntil;
    }

    /**
     * Refuses a second concurrent run of the same named operation (e.g. "resume:TEST3") —
     * a real Resume/Promote/Validate/Publish can genuinely take well past a few seconds (a
     * git push plus, often, a real Salesforce check-only deploy), and a UI element that
     * looks like it's done too early (see the sidebar's busy-bar timeout) invites a second
     * click that would otherwise start a SECOND git operation in the same working tree while
     * the first is still running — corrupting neither repo state nor deploy result, but
     * producing exactly the confusing "keeps on running" experience two overlapping
     * operations racing each other would create. Callers: `if (!gitHelper.tryBeginOperation(key))
     * { warn and return; }` then `finally { gitHelper.endOperation(key); }`.
     */
    private _inFlightOperations = new Set<string>();
    tryBeginOperation(key: string): boolean {
        if (this._inFlightOperations.has(key)) { return false; }
        this._inFlightOperations.add(key);
        return true;
    }
    endOperation(key: string): void {
        this._inFlightOperations.delete(key);
    }

    /** Raw `origin` remote URL, or null if there isn't one. */
    async getRemoteUrl(): Promise<string | null> {
        try {
            return await this.git(["remote", "get-url", "origin"]);
        } catch {
            return null;
        }
    }

    /**
     * Resolves the repo identity to pass as a provider client's `repoOverride`. Settings
     * (sfDevops.repoWorkspace/repoSlug) always win when both are set — this only fills the
     * gap by deriving from the `origin` remote URL when they're not, so PR/branch links and
     * PR creation don't silently no-op on a repo that never had those settings configured.
     */
    async resolveRepoIdentity(providerClient: IGitProviderClient): Promise<{ workspace: string; repoSlug: string } | undefined> {
        if (getRepoWorkspace() && getRepoSlug()) { return undefined; }
        const remoteUrl = await this.getRemoteUrl();
        return (remoteUrl ? providerClient.parseRemoteUrl(remoteUrl) : null) ?? undefined;
    }

    /**
     * Detects distinct Salesforce metadata areas in the working tree.
     * Used to warn developers who may be mixing multiple stories.
     *
     * Returns object like:
     *   { areas: ["Account", "Opportunity"], files: [...] }
     */
    async detectMultipleAreas(): Promise<{ areas: string[]; files: string[]; hasMultiple: boolean }> {
        const files = await this.workingTreeFiles();
        const sourceRoot = getSourceRootFolder();

        const sfFiles = files.filter(f =>
            f.includes(sourceRoot) &&
            (f.endsWith("-meta.xml") || f.endsWith(".cls") || f.endsWith(".trigger") ||
             f.endsWith(".js") || f.endsWith(".html") || f.endsWith(".css"))
        );

        // Extract the top-level object/component name from path
        const areaSet = new Set<string>();
        for (const file of sfFiles) {
            const parts = file.split("/");
            // path like: force-app/main/default/objects/Account/fields/Name.field-meta.xml
            // or:         force-app/main/default/classes/AccountService.cls
            const typeIndex = parts.indexOf("default");
            if (typeIndex !== -1 && parts.length > typeIndex + 2) {
                const metaType = parts[typeIndex + 1];  // e.g. "objects", "classes"
                const name    = parts[typeIndex + 2];   // e.g. "Account", "AccountService.cls"
                // For objects, group by object name. For classes/triggers, group by component name.
                const cleanName = name.replace(/\..*$/, "");  // strip extension
                areaSet.add(`${metaType}/${cleanName}`);
            }
        }

        // Group by top-level domain (objects vs classes vs lwc etc)
        const topLevelAreas = new Set<string>();
        for (const area of areaSet) {
            const [type, name] = area.split("/");
            if (type === "objects") {
                topLevelAreas.add(name);  // Account, Opportunity etc
            } else {
                topLevelAreas.add(type);  // classes, lwc, flows etc
            }
        }

        const areas = Array.from(topLevelAreas);
        return {
            areas,
            files: sfFiles,
            hasMultiple: topLevelAreas.size > 2,  // 3+ distinct areas is a warning signal
        };
    }

    // ── Commit message helpers ────────────────────────────────────────────────

    buildCommitMessage(storyId: string, description: string): string {
        // Conventional commit format
        return `feat(${storyId}): ${description}`;
    }

    buildPRTitle(storyId: string, description: string, targetEnv: string): string {
        return `[${storyId}] ${description} → ${targetEnv.toUpperCase()}`;
    }

    // ── Generic ref/branch primitives (used by the 2GP Packaging Release Gate) ─

    /** Changed files between two remote refs, restricted to `pathspec` if given. */
    async diffNameStatusBetween(
        fromRef:  string,
        toRef:    string,
        pathspec?: string
    ): Promise<{ path: string; change: "added" | "modified" | "deleted" }[]> {
        const args = ["diff", "--name-status", `origin/${fromRef}`, `origin/${toRef}`];
        if (pathspec) { args.push("--", pathspec); }
        const raw = await this.git(args);

        return raw.split("\n").filter(Boolean).map(line => {
            const tab = line.indexOf("\t");
            const code = line.slice(0, tab).trim();
            const filePath = line.slice(tab + 1).trim();
            const change: "added" | "modified" | "deleted" =
                code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
            return { path: filePath, change };
        });
    }

    /** Every file path at a remote ref, optionally restricted to `pathspec` — used to find candidate test classes without needing a local checkout. */
    async listFilesAtRef(ref: string, pathspec?: string): Promise<string[]> {
        try {
            const args = ["ls-tree", "-r", "--name-only", `origin/${ref}`];
            if (pathspec) { args.push("--", pathspec); }
            const out = await this.git(args);
            return out ? out.split("\n").filter(Boolean) : [];
        } catch {
            return [];
        }
    }

    /** File content at a remote ref, or null if it doesn't exist there. */
    async fileContentAtRef(ref: string, filePath: string): Promise<string | null> {
        try {
            return await this.git(["show", `origin/${ref}:${filePath}`]);
        } catch {
            return null;
        }
    }

    /** File content at a bare commit SHA (not a branch ref) — used to diff against a recorded last-deployed marker, which is stored as a raw SHA, not a branch name. */
    async fileContentAtSha(sha: string, filePath: string): Promise<string | null> {
        try {
            return await this.git(["show", `${sha}:${filePath}`]);
        } catch {
            return null;
        }
    }

    /** Commit log between two remote refs — used to build release notes' "work items" section. */
    /**
     * Commits on `toRef` not on `fromRef` — used for release notes and the promote
     * picker's story detection, both of which scan commit MESSAGES for a story/ticket id.
     * `--no-merges` excludes auto-generated "Merge pull request #N from ..." commits: with
     * a loose ticketKeyPattern (e.g. "\S.*", matching almost anything), those would
     * otherwise get scanned too and produce a bogus "story" that's really just git noise.
     */
    async commitLogBetween(
        fromRef: string,
        toRef:   string
    ): Promise<{ hash: string; date: string; author: string; message: string }[]> {
        const format = "%H%x1f%aI%x1f%an%x1f%s";
        const raw = await this.git(["log", "--no-merges", `origin/${fromRef}..origin/${toRef}`, `--pretty=format:${format}`]);
        return raw.split("\n").filter(Boolean).map(line => {
            const [hash, date, author, message] = line.split("\x1f");
            return { hash: hash.slice(0, 7), date, author, message };
        });
    }

    /** Creates (or resets) a local branch cut from a remote ref and checks it out. */
    async createLocalBranchFrom(branchName: string, fromRef: string): Promise<void> {
        await this.git(["fetch", "origin", "--prune"]);
        await this.git(["checkout", "-B", branchName, `origin/${fromRef}`]);
    }

    /** Creates a local branch pointing at an exact commit SHA — used for rollback to check out a known-good snapshot. */
    async createTempBranchAtSha(sha: string, branchName: string): Promise<void> {
        await this.git(["checkout", "-B", branchName, sha]);
    }

    /** Deletes a local branch (force) — used to clean up after a rollback temp branch. */
    async deleteTempBranch(branchName: string): Promise<void> {
        await this.git(["branch", "-D", branchName]).catch(() => {});
    }

    /** Writes a file under the workspace root, creating parent directories as needed. */
    async writeWorkspaceFile(relPath: string, content: string): Promise<void> {
        const full = path.join(this.workspaceRoot, relPath);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, content, "utf8");
    }

    /** Removes a file under the workspace root, if present. */
    async removeWorkspaceFile(relPath: string): Promise<void> {
        await fs.promises.rm(path.join(this.workspaceRoot, relPath), { force: true });
    }

    /** Reads a file under the workspace root, or null if it doesn't exist. */
    async readWorkspaceFile(relPath: string): Promise<string | null> {
        try {
            return await fs.promises.readFile(path.join(this.workspaceRoot, relPath), "utf8");
        } catch {
            return null;
        }
    }

    /** Stages everything and commits, if there's anything to commit. Returns whether a commit happened. */
    async commitAllChanges(message: string): Promise<boolean> {
        await this.git(["add", "-A"]);
        const status = await this.git(["status", "--porcelain"]);
        if (!status) { return false; }
        await this.git(["commit", "-m", message]);
        return true;
    }

    /** Pushes a local branch, creating its upstream on `origin`. */
    async pushNewBranch(branchName: string): Promise<void> {
        await this.git(["push", "-u", "origin", branchName]);
    }
}

/**
 * Shows a warning that local changes are blocking an operation, with a "Review Changes"
 * button that reveals VS Code's own Source Control view — real color-coded diffs, staging,
 * discard, commit — instead of just telling the user to go figure it out for themselves.
 * If some of those changes are already staged on a feature branch, also offers a one-click
 * "Commit to Dev" that runs the same Commit & Publish flow the toolbar button does — no
 * need to switch to Source Control just to finish something already staged.
 *
 * When `offerStash` is set (the operations that are about to force-checkout a branch from
 * origin — Deploy/Validate/Promote/Resume — none of which would ever have included local
 * edits anyway, since they always act on what's already pushed), also offers "Stash &
 * Continue": sets the working tree aside and lets the caller proceed immediately instead of
 * making the user go handle it manually and re-click the same button afterward. Returns the
 * stash's label if it stashed something (the caller is expected to restore it with
 * `gitHelper.restoreStash` once the operation finishes, success or fail), or null if the
 * user picked anything else (including "nothing to stash" — same as declining).
 */
export async function warnUncommittedChanges(
    gitHelper: GitHelper,
    reason: string,
    options?: { offerStash?: boolean }
): Promise<string | null> {
    const files  = await gitHelper.workingTreeFiles();
    const preview = files.slice(0, 5).join(", ") + (files.length > 5 ? `, +${files.length - 5} more` : "");

    const staged = await gitHelper.stagedFiles();
    const branch = await gitHelper.currentBranch();
    const canCommitToDev = staged.length > 0 && isFeatureBranchName(branch);

    const stagedNote = canCommitToDev ? ` (${staged.length} already staged)` : "";
    const actions = [
        ...(options?.offerStash ? ["Stash & Continue"] : []),
        ...(canCommitToDev ? ["Commit to Dev"] : []),
        "Review Changes",
    ];
    const stashHint = options?.offerStash
        ? `\n\n"Stash & Continue" sets these aside and restores them automatically once this finishes.` : "";

    const choice = await vscode.window.showWarningMessage(
        `${reason}\n\n${files.length} file(s) uncommitted: ${preview}${stagedNote}${stashHint}`,
        ...actions
    );
    if (choice === "Stash & Continue") {
        const label = `sf-devops-autostash-${Date.now()}`;
        const stashed = await gitHelper.stashUnstagedChanges(label);
        return stashed ? label : null;
    }
    if (choice === "Review Changes") {
        await vscode.commands.executeCommand("workbench.view.scm");
    } else if (choice === "Commit to Dev") {
        await vscode.commands.executeCommand("sfDevops.commitAndPush");
    }
    return null;
}
