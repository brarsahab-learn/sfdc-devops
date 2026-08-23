// DeploymentPlanner.ts — pure grouping/selection logic for the deployment dashboard.
// No fs/vscode/CLI dependency here; GitHelper.ts supplies the raw commit/file data.

import { AuditChangedFile } from "./AuditLog";

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
