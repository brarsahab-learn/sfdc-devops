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
    promoBranchName as buildPromoBranchName, getSourceRootFolder,
} from "./config";
import { createGitProviderClient } from "./GitProviderClient";
import { AuditEntry, renderAuditHtml } from "./AuditLog";

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
    private get workspaceRoot(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    }

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", args, {
            cwd:      this.workspaceRoot,
            timeout:  30_000,
        });
        return stdout.trim();
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

    /** Re-renders the audit HTML from the current JSON, e.g. before opening it. */
    async regenerateAuditHtml(): Promise<void> {
        try {
            fs.writeFileSync(await this.auditHtmlPath(), renderAuditHtml(await this.readAuditEntries()));
        } catch { /* best effort */ }
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
     * Like `commitLogBetween`, but takes raw refs with no `origin/` prefixing — needed
     * when `fromRef` is a bare commit SHA (e.g. a recorded last-deployed marker) rather
     * than a branch name.
     */
    async commitLogBetweenRaw(
        fromRef: string,
        toRef:   string
    ): Promise<{ hash: string; date: string; author: string; message: string }[]> {
        const format = "%H%x1f%aI%x1f%an%x1f%s";
        const raw = await this.git(["log", `${fromRef}..${toRef}`, `--pretty=format:${format}`]);
        return raw.split("\n").filter(Boolean).map(line => {
            const [hash, date, author, message] = line.split("\x1f");
            return { hash, date, author, message };
        });
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

    /** Validate Only pushes the validate-branch template; Promote & Deploy pushes the promotion-branch template (the PR source). */
    promoBranchName(storyId: string, targetEnv: string, mode: "validate" | "promote"): string {
        return buildPromoBranchName(storyId, targetEnv, mode);
    }

    /**
     * Commit & Publish: applies the story's squashed net changes straight onto the dev
     * branch and pushes it — no PR, no Dev org deploy.
     * On conflict the cherry-pick is LEFT in place for resolve-and-resume.
     */
    async publishToDevBranch(storyId: string): Promise<PromotionOutcome> {
        const base      = getBaseBranch();
        const devBranch = getDevBranch();

        await this.git(["fetch", "origin", "--prune"]);
        try {
            await this.git(["rev-parse", "--verify", `origin/${devBranch}`]);
        } catch {
            throw new Error(`${devBranch} branch not found on remote (origin/${devBranch}).`);
        }

        await this.git(["cherry-pick", "--abort"]).catch(() => {});
        const squashSha = await this.storySquashRef(storyId, base);
        await this.git(["checkout", "-B", devBranch, `origin/${devBranch}`]);
        await this.writePending({ kind: "dev-publish", storyId });

        try {
            await this.git(["-c", "core.editor=true", "cherry-pick", squashSha]);
        } catch {
            const conflicts = await this.unmergedFiles();
            if (conflicts.length === 0) {
                // Story already present in dev → finish the no-op cherry-pick.
                await this.git(["cherry-pick", "--skip"]).catch(() => {});
            } else {
                return { status: "conflict", branch: devBranch, conflicts };
            }
        }

        await this.completeDevPublish(storyId);
        return { status: "clean", branch: devBranch, conflicts: [] };
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
    async beginPromotion(
        storyId:   string,
        targetEnv: string,
        mode:      "validate" | "promote"
    ): Promise<PromotionOutcome> {
        const featureBranch   = featureBranchName(storyId);
        const promotionBranch = this.promoBranchName(storyId, targetEnv, mode);
        const base   = getBaseBranch();

        await this.git(["fetch", "origin", "--prune"]);
        try {
            await this.git(["rev-parse", "--verify", `origin/${featureBranch}`]);
        } catch {
            throw new Error(`Source branch not found on remote: ${featureBranch}. Push the feature branch first.`);
        }
        try {
            await this.git(["rev-parse", "--verify", `origin/${targetEnv}`]);
        } catch {
            throw new Error(`Target environment branch not found: origin/${targetEnv}.`);
        }

        await this.git(["cherry-pick", "--abort"]).catch(() => {});
        const squashSha = await this.storySquashRef(storyId, base);
        // Copado model: cut every promotion branch from its own target env branch.
        await this.git(["checkout", "-B", promotionBranch, `origin/${targetEnv}`]);
        await this.writePending({ kind: "promotion", storyId, targetEnv, mode });

        try {
            await this.git(["-c", "core.editor=true", "cherry-pick", squashSha]);
            return { status: "clean", branch: promotionBranch, conflicts: [] };
        } catch {
            const conflicts = await this.unmergedFiles();
            if (conflicts.length === 0) {
                // Story already present in the target → finish the no-op cherry-pick.
                await this.git(["cherry-pick", "--skip"]).catch(() => {});
                return { status: "clean", branch: promotionBranch, conflicts: [] };
            }
            return { status: "conflict", branch: promotionBranch, conflicts };
        }
    }

    /**
     * Continues the pending cherry-pick after conflicts are resolved.
     * Returns "conflict" again if a later commit still conflicts.
     */
    async continuePendingOperation(): Promise<PromotionOutcome> {
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
    }

    /** Aborts the pending cherry-pick and returns to the feature branch. */
    async abortPendingOperation(storyId: string): Promise<void> {
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
     * Tags (promote only) and pushes the completed branch.
     * Call after `beginPromotion`/`continuePendingOperation` returns "clean".
     */
    async finalizePromotion(
        storyId:   string,
        targetEnv: string,
        mode:      "validate" | "promote"
    ): Promise<{ branch: string; tag: string }> {
        const promotionBranch = this.promoBranchName(storyId, targetEnv, mode);
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

    /** True if `origin/<branch>` has a commit whose message mentions the story id. */
    async branchContainsStory(branch: string, storyId: string): Promise<boolean> {
        try {
            const out = await this.git(["log", `origin/${branch}`, "--grep", storyId, "--oneline", "-1"]);
            return out.trim().length > 0;
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

    async isCoveragePassed(storyId: string): Promise<boolean> {
        const data = await this.readCoverage();
        return Boolean(data[storyId]?.passed);
    }

    async recordCoveragePassed(storyId: string, details: object): Promise<void> {
        const data = await this.readCoverage();
        data[storyId] = { passed: true, ...details, date: new Date().toISOString() };
        try {
            fs.writeFileSync(await this.coverageFilePath(), JSON.stringify(data, null, 2));
        } catch { /* best effort */ }
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

    /** Checks out an existing branch */
    async checkoutBranch(branch: string): Promise<void> {
        await this.git(["fetch", "origin"]);
        try {
            await this.git(["checkout", branch]);
        } catch {
            await this.git(["checkout", "-b", branch, `origin/${branch}`]);
        }
    }

    /** Raw `origin` remote URL, or null if there isn't one. */
    async getRemoteUrl(): Promise<string | null> {
        try {
            return await this.git(["remote", "get-url", "origin"]);
        } catch {
            return null;
        }
    }

    /** Derives the repo workspace + slug from the `origin` remote URL, using the configured provider's URL shape. */
    async getRemoteRepoIdentity(context: vscode.ExtensionContext): Promise<{ workspace: string; repoSlug: string } | null> {
        let url: string;
        try {
            url = await this.git(["remote", "get-url", "origin"]);
        } catch {
            return null;
        }
        return createGitProviderClient(context).parseRemoteUrl(url);
    }

    /** @deprecated use getRemoteRepoIdentity — kept for backward compatibility with older callers. */
    async getBitbucketRepo(): Promise<{ workspace: string; repoSlug: string } | null> {
        let url: string;
        try {
            url = await this.git(["remote", "get-url", "origin"]);
        } catch {
            return null;
        }
        const m = url.match(/bitbucket\.org[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
        return m ? { workspace: m[1], repoSlug: m[2] } : null;
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

    /** File content at a remote ref, or null if it doesn't exist there. */
    async fileContentAtRef(ref: string, filePath: string): Promise<string | null> {
        try {
            return await this.git(["show", `origin/${ref}:${filePath}`]);
        } catch {
            return null;
        }
    }

    /** Commit log between two remote refs — used to build release notes' "work items" section. */
    async commitLogBetween(
        fromRef: string,
        toRef:   string
    ): Promise<{ hash: string; date: string; author: string; message: string }[]> {
        const format = "%H%x1f%aI%x1f%an%x1f%s";
        const raw = await this.git(["log", `origin/${fromRef}..origin/${toRef}`, `--pretty=format:${format}`]);
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
