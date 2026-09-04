// DeploymentPlanner.ts — pure grouping/selection logic for the deployment dashboard.
// No fs/vscode/CLI dependency here; GitHelper.ts supplies the raw commit/file data.

import { AuditChangedFile, metadataTypeForPath } from "./AuditLog";

// ── Apex test auto-detection — shared by the Deployment Dashboard and the mandatory
// promotion-validate step, so "run just the relevant tests" means the same thing and runs
// the same speed everywhere, instead of the Dashboard getting the smart/fast path and
// promotion validation quietly defaulting to the slow, org-wide RunLocalTests. ────────────

/** A class named like a test doesn't need a test of its own — it IS one. */
export function isLikelyTestClass(name: string): boolean {
    return /(_Test|Test|Tests)$/.test(name) || /^Test/.test(name);
}

export const VALID_TEST_LEVELS = ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"];

/**
 * Picks the real `--test-level`/`--tests` to actually send to `sf project deploy`.
 *
 * Sandbox vs production matters: Salesforce requires tests for production deployments, but
 * sandbox deployments with no Apex/test-class changes get `NoTestRun` to skip the overhead.
 *
 *  - "all"  → RunAllTestsInOrg, unconditionally.
 *  - "auto" with at least one detected test → RunSpecifiedTests naming just those tests.
 *  - "auto" with Apex in the selection but nothing detected → RunLocalTests (RunSpecifiedTests
 *    with an empty list is rejected by the CLI).
 *  - no Apex in the selection + sandbox (isProd === false) → NoTestRun.
 *  - no Apex in the selection + production (isProd === true) → use the configured level
 *    (Salesforce mandates tests on production deployments; never override to NoTestRun).
 */
export function resolveEffectiveTestLevel(
    configuredLevel: string,
    testMode: "auto" | "all",
    apexClassesInSelection: string[],
    apexTestMap: Record<string, string | null>,
    isProd = false,
): { testLevel: string; tests?: string[] } {
    if (testMode === "all") { return { testLevel: "RunAllTestsInOrg" }; }
    const detected = Array.from(new Set(
        apexClassesInSelection.map(name => apexTestMap[name]).filter((t): t is string => Boolean(t))
    ));
    if (detected.length > 0) { return { testLevel: "RunSpecifiedTests", tests: detected }; }
    if (apexClassesInSelection.length > 0) { return { testLevel: "RunLocalTests" }; }
    // No Apex in the deployment package.
    if (!isProd) { return { testLevel: "NoTestRun" }; }
    return { testLevel: VALID_TEST_LEVELS.includes(configuredLevel) ? configuredLevel : "RunLocalTests" };
}

/** Apex class basenames (excluding test classes themselves) among the given files — used to figure out which tests to auto-pick for exactly what's being deployed/validated. */
export function apexClassNamesIn(files: { path: string }[]): string[] {
    return Array.from(new Set(
        files.filter(f => f.path.endsWith(".cls") && metadataTypeForPath(f.path) === "ApexClass")
             .map(f => f.path.split("/").pop()!.replace(/\.cls$/, ""))
    )).filter(name => !isLikelyTestClass(name));
}

/**
 * Builds class→detected-test-name and test-name→file-path(s) maps from a full listing of
 * `.cls`/`.cls-meta.xml` paths on a branch (e.g. GitHelper.listFilesAtRef) and the set of
 * candidate (pending) Apex class names — the naming convention match (`<Class>Test`,
 * `<Class>_Test`, `Test<Class>`, `<Class>Tests`) lives here once. `apexTestFilePaths` is
 * what lets a caller fold a specified test's own file(s) into the deploy even when they
 * weren't otherwise selected — RunSpecifiedTests requires the named test class to actually
 * be part of the deployment package (or already exist in the target org), which a
 * never-deployed-before env won't have yet.
 */
export function buildApexTestMap(
    allClsFiles: string[],
    candidateClasses: string[]
): { apexTestMap: Record<string, string | null>; apexTestFilePaths: Record<string, string[]> } {
    const basenameToPaths = new Map<string, string[]>();
    for (const f of allClsFiles) {
        if (!f.endsWith(".cls") && !f.endsWith(".cls-meta.xml")) { continue; }
        const base = f.split("/").pop()!.replace(/\.cls(-meta\.xml)?$/, "");
        if (!basenameToPaths.has(base)) { basenameToPaths.set(base, []); }
        basenameToPaths.get(base)!.push(f);
    }
    const apexTestMap: Record<string, string | null> = {};
    const apexTestFilePaths: Record<string, string[]> = {};
    for (const name of candidateClasses) {
        const candidates = [`${name}Test`, `${name}_Test`, `Test${name}`, `${name}Tests`];
        const match = candidates.find(c => basenameToPaths.has(c));
        apexTestMap[name] = match ?? null;
        if (match) { apexTestFilePaths[match] = basenameToPaths.get(match)!; }
    }
    return { apexTestMap, apexTestFilePaths };
}

export interface CommitInfo {
    hash:    string;
    date:    string;
    author:  string;
    message: string;
}

export interface StoryChangeGroup {
    storyId:    string;
    commits:    CommitInfo[];
    files:      AuditChangedFile[];
    /** Other story groups that also touch at least one of this group's files. */
    sharedWith: string[];
}

/**
 * Every commit landing on an environment branch via this extension is one of its own
 * squash commits — "${storyId}: consolidated story changes" (see
 * `GitHelper.storySquashRef`) — so the story id is just the text before the first ": ".
 * Commits that don't match that shape (e.g. a manual merge) are grouped under "other".
 */
function storyIdFromCommitMessage(message: string): string {
    const idx = message.indexOf(": ");
    return idx > 0 ? message.slice(0, idx) : "other";
}

export function groupChangesByStory(
    commits:      CommitInfo[],
    filesByHash:  Map<string, AuditChangedFile[]>
): StoryChangeGroup[] {
    const byStory = new Map<string, StoryChangeGroup>();

    for (const commit of commits) {
        const storyId = storyIdFromCommitMessage(commit.message);
        const files = filesByHash.get(commit.hash) ?? [];
        let group = byStory.get(storyId);
        if (!group) {
            group = { storyId, commits: [], files: [], sharedWith: [] };
            byStory.set(storyId, group);
        }
        group.commits.push(commit);
        for (const f of files) {
            if (!group.files.some(existing => existing.path === f.path)) {
                group.files.push(f);
            }
        }
    }

    const groups = Array.from(byStory.values());

    // Flag files shared across more than one group — surfaced for the user to decide,
    // never auto-resolved (see the deferred dependency-resolution work in the plan).
    for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
            const a = groups[i], b = groups[j];
            const shareFiles = a.files.some(f => b.files.some(g => g.path === f.path));
            if (shareFiles) {
                if (!a.sharedWith.includes(b.storyId)) { a.sharedWith.push(b.storyId); }
                if (!b.sharedWith.includes(a.storyId)) { b.sharedWith.push(a.storyId); }
            }
        }
    }

    return groups;
}

/**
 * Extracts a story id from a single commit message, recognizing this extension's own two
 * commit-message shapes STRUCTURALLY before falling back to the configured ticket-key
 * pattern: `GitHelper.storySquashRef`'s squash commit ("{storyId}: consolidated story
 * changes", on dev) and `promoteStory.ts`'s `buildPRTitle` ("[{storyId}] ... → {env}", what
 * a squash-merged PR's commit message becomes on a later env branch). Checking these first
 * matters because `sfDevops.ticketKeyPattern` can legitimately be configured very loosely
 * (e.g. `\S.*`, to allow free-text story ids in branch names) — under a loose pattern, the
 * SAME story's squash commit and PR-title commit would otherwise match as two different
 * "story ids" (the whole differently-worded message each time), splitting one story into
 * two entries. Anything that matches neither shape (e.g. a non-squash merge commit) still
 * falls back to the configured pattern.
 */
export function storyIdFromMessage(message: string, pattern: RegExp): string | null {
    const bracketed = message.match(/^\[([^\]]+)\]/);
    if (bracketed) { return bracketed[1]; }
    const colonIdx = message.indexOf(": ");
    if (colonIdx > 0) { return message.slice(0, colonIdx); }
    const m = message.match(pattern);
    return m ? m[0] : null;
}

/**
 * Groups commits by story/ticket id (see `storyIdFromMessage`). Commits that don't match
 * anything are simply omitted — there's no "other" bucket here, unlike `groupChangesByStory`
 * — the caller only cares about real story ids to offer for promotion.
 */
export function distinctStoryIdsFromCommits(
    commits: CommitInfo[],
    pattern: RegExp
): Map<string, CommitInfo[]> {
    const byStory = new Map<string, CommitInfo[]>();
    for (const c of commits) {
        const id = storyIdFromMessage(c.message, pattern);
        if (!id) { continue; }
        if (!byStory.has(id)) { byStory.set(id, []); }
        byStory.get(id)!.push(c);
    }
    return byStory;
}

export type DeploySelectionMode = "all" | "stories" | "files";

export interface DeploySelection {
    mode:      DeploySelectionMode;
    storyIds?: string[];  // mode "stories"
    files?:    string[];  // mode "files"
}

/**
 * Resolves a selection into the exact set of file paths to deploy (for the audit trail
 * and for building `--source-dir` args), plus a human summary. "all" means "deploy
 * everything currently changed" — DeploymentEngine.runDeploy treats an empty file list
 * paired with mode "all" as "no --source-dir override, deploy the whole source root".
 */
export function resolveSelection(
    selection: DeploySelection,
    groups:    StoryChangeGroup[],
    allFiles:  AuditChangedFile[]
): { files: AuditChangedFile[]; summary: string } {
    if (selection.mode === "all") {
        return { files: allFiles, summary: `All changes (${allFiles.length} file(s))` };
    }
    if (selection.mode === "stories") {
        const wanted = new Set(selection.storyIds ?? []);
        const picked = groups.filter(g => wanted.has(g.storyId));
        const files = dedupeByPath(picked.flatMap(g => g.files));
        return { files, summary: `${picked.map(g => g.storyId).join(", ") || "(none selected)"} (${files.length} file(s))` };
    }
    const wantedPaths = new Set(selection.files ?? []);
    const files = allFiles.filter(f => wantedPaths.has(f.path));
    return { files, summary: `${files.length} hand-picked file(s)` };
}

function dedupeByPath(files: AuditChangedFile[]): AuditChangedFile[] {
    const seen = new Map<string, AuditChangedFile>();
    for (const f of files) { seen.set(f.path, f); }
    return Array.from(seen.values());
}
