// PackagingEngine.ts
// The Dedicated 2GP Release Gate: compares the UAT branch against the 2GP packaging
// baseline, segregates changed metadata into managed/unmanaged, generates release notes,
// bumps the package version, and opens a PR — all settings-driven via
// getPackagingSettings()/getPackageBaselineBranch() in config.ts, same as every other
// workflow in this extension.

import * as path from "path";
import { GitHelper } from "./GitHelper";
import { IGitProviderClient } from "./GitProviderClient";
import { matchesAnyGlob } from "./GlobMatch";
import {
    getPackagingSettings, getPackageBaselineBranch, getPackagingSourceBranch,
} from "./config";

export type BumpType = "patch" | "minor" | "major";

export interface PrepareBetaResult {
    branch:            string;
    version:           string;
    managedFiles:      string[];
    unmanagedFiles:    string[];
    excludedFiles:     string[];
    deletedFiles:      string[];
    releaseNotesPath:  string;
    releaseNotes:      string;
    prUrl?:            string;
}

/** Bumps "1.2.3.NEXT" (or "1.2.3") → the requested segment, preserving any trailing build token. */
function bumpedVersionString(versionNumber: string, bumpType: BumpType): { full: string; semver: string } {
    const m = versionNumber.match(/^(\d+)\.(\d+)\.(\d+)(\..*)?$/);
    if (!m) { throw new Error(`Unrecognized versionNumber format in sfdx-project.json: "${versionNumber}"`); }
    let major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3]);
    const suffix = m[4] || "";

    if (bumpType === "major") { major += 1; minor = 0; patch = 0; }
    else if (bumpType === "minor") { minor += 1; patch = 0; }
    else { patch += 1; }

    return { full: `${major}.${minor}.${patch}${suffix}`, semver: `${major}.${minor}.${patch}` };
}

/**
 * Reads sfdx-project.json at the packaging baseline ref, bumps the target package
 * directory's versionNumber, and returns both the updated file content and the new
 * semver string (e.g. "1.3.0") used for the branch name and release notes filename.
 */
async function bumpSfdxProjectVersion(
    gitHelper:   GitHelper,
    baselineRef: string,
    packageName: string,
    bumpType:    BumpType
): Promise<{ updatedJson: string; semver: string; full: string }> {
    const raw = await gitHelper.fileContentAtRef(baselineRef, "sfdx-project.json");
    if (!raw) { throw new Error(`sfdx-project.json not found on origin/${baselineRef}.`); }

    const project = JSON.parse(raw);
    const dirs: any[] = project.packageDirectories || [];
    const target = packageName
        ? dirs.find(d => d.package === packageName)
        : dirs.find(d => typeof d.versionNumber === "string");

    if (!target) {
        throw new Error(
            packageName
                ? `No packageDirectories entry with package "${packageName}" found in sfdx-project.json.`
                : `No packageDirectories entry with a versionNumber found in sfdx-project.json. Set sfDevops.packaging.packageName.`
        );
    }

    const { full, semver } = bumpedVersionString(target.versionNumber, bumpType);
    target.versionNumber = full;

    return { updatedJson: JSON.stringify(project, null, 4) + "\n", semver, full };
}

interface SegregatedFile {
    sourcePath: string;
    targetPath: string;
    bucket:     "managed" | "unmanaged";
    change:     "added" | "modified" | "deleted";
}

/** Classifies one changed file (repo-relative path under packaging.sourceBase) per the packaging settings. */
function classify(
    filePath: string,
    change: "added" | "modified" | "deleted",
    settings: ReturnType<typeof getPackagingSettings>
): { kind: "excluded" } | SegregatedFile {
    if (matchesAnyGlob(filePath, settings.excludedMetadata)) { return { kind: "excluded" }; }

    const suffix = filePath.slice(settings.sourceBase.length);
    const isPatch = matchesAnyGlob(filePath, settings.patchOverrides);
    const bucket: "managed" | "unmanaged" = isPatch ? "unmanaged" : "managed";
    const targetRoot = isPatch ? settings.unmanagedTarget : settings.managedTarget;

    return { sourcePath: filePath, targetPath: path.posix.join(targetRoot, suffix), bucket, change };
}

/** Builds the docs/releases/vX.Y.Z-RELEASE-NOTES.md content. */
function buildReleaseNotes(
    version:        string,
    sourceBranch:   string,
    baselineBranch: string,
    managed:        SegregatedFile[],
    unmanaged:      SegregatedFile[],
    excludedCount:  number,
    commits:        { hash: string; date: string; author: string; message: string }[],
    extractStoryId: (branch: string | null | undefined) => string
): string {
    const lines: string[] = [];
    lines.push(`# 2GP Beta Release Notes — v${version}`, "");
    lines.push(`| Field | Value |`, `|-------|-------|`);
    lines.push(`| **Version** | ${version} |`);
    lines.push(`| **Date** | ${new Date().toISOString().slice(0, 10)} |`);
    lines.push(`| **Compared** | \`${baselineBranch}\` → \`${sourceBranch}\` |`, "");

    const section = (title: string, files: SegregatedFile[]) => {
        lines.push(`## ${title} (${files.length})`, "");
        if (files.length === 0) {
            lines.push("_None._", "");
            return;
        }
        for (const f of files) {
            const marker = f.change === "added" ? "＋" : f.change === "deleted" ? "－" : "±";
            lines.push(`- ${marker} \`${f.sourcePath}\``);
        }
        lines.push("");
    };

    section("Managed metadata", managed);
    section("Unmanaged metadata (patch overrides / server-error workarounds)", unmanaged);
    if (excludedCount > 0) {
        lines.push(`## Excluded from packaging (${excludedCount})`, "", "_Matched sfDevops.packaging.excludedMetadata — not copied to either bucket._", "");
    }

    lines.push(`## Git work items / commits (${commits.length})`, "");
    if (commits.length === 0) {
        lines.push("_No commits found between the two branches._");
    } else {
        for (const c of commits) {
            const storyId = extractStoryId(c.message);
            const tag = storyId ? `**${storyId}** — ` : "";
            lines.push(`- \`${c.hash}\` ${c.date.slice(0, 10)} — ${tag}${c.message} (${c.author})`);
        }
    }
    lines.push("");

    return lines.join("\n");
}

/**
 * Runs the full 2GP Packaging Release Gate: diff UAT vs the packaging baseline,
 * segregate into managed/unmanaged, bump the version, write release notes, commit,
 * push, and open a PR. Throws with a user-facing message on any hard failure; the
 * caller (the command) is responsible for progress reporting and confirmation.
 */
export async function prepare2gpBeta(
    gitHelper:      GitHelper,
    providerClient: IGitProviderClient,
    bumpType:       BumpType,
    extractStoryId: (branch: string | null | undefined) => string,
    onProgress?:    (message: string) => void
): Promise<PrepareBetaResult> {
    const settings  = getPackagingSettings();
    const baseline  = getPackageBaselineBranch();
    const source    = getPackagingSourceBranch();
    const report    = (m: string) => onProgress?.(m);

    report(`Fetching and comparing origin/${baseline}…origin/${source}…`);
    await gitHelper.fetchRemote();
    if (!(await gitHelper.remoteBranchExists(baseline))) {
        throw new Error(`Packaging baseline branch not found: origin/${baseline}. Check sfDevops.packageBaselineBranch.`);
    }
    if (!(await gitHelper.remoteBranchExists(source))) {
        throw new Error(`Source branch not found: origin/${source}. Check sfDevops.packagingSourceBranch (or the UAT entry in sfDevops.environments).`);
    }

    const rawDiff = await gitHelper.diffNameStatusBetween(baseline, source, settings.sourceBase);
    if (rawDiff.length === 0) {
        throw new Error(`No changes found under ${settings.sourceBase} between origin/${baseline} and origin/${source} — nothing to package.`);
    }

    const managed: SegregatedFile[] = [];
    const unmanaged: SegregatedFile[] = [];
    const excluded: string[] = [];
    const deleted: string[] = [];

    for (const { path: filePath, change } of rawDiff) {
        const classified = classify(filePath, change, settings);
        if ("kind" in classified) { excluded.push(filePath); continue; }
        if (classified.change === "deleted") { deleted.push(classified.sourcePath); }
        (classified.bucket === "managed" ? managed : unmanaged).push(classified);
    }

    report("Bumping package version…");
    const { updatedJson, semver, full } = await bumpSfdxProjectVersion(gitHelper, baseline, settings.packageName, bumpType);
    const branchName = `2gp-beta/v${semver}`;

    report(`Creating ${branchName} from origin/${baseline}…`);
    await gitHelper.createLocalBranchFrom(branchName, baseline);

    report("Segregating changed metadata…");
    for (const f of [...managed, ...unmanaged]) {
        if (f.change === "deleted") {
            await gitHelper.removeWorkspaceFile(f.targetPath);
            continue;
        }
        const content = await gitHelper.fileContentAtRef(source, f.sourcePath);
        if (content === null) { continue; } // raced with a further upstream change; skip rather than fail the whole run
        await gitHelper.writeWorkspaceFile(f.targetPath, content);
    }

    await gitHelper.writeWorkspaceFile("sfdx-project.json", updatedJson);

    report("Generating release notes…");
    const commits = await gitHelper.commitLogBetween(baseline, source);
    const releaseNotes = buildReleaseNotes(semver, source, baseline, managed, unmanaged, excluded.length, commits, extractStoryId);
    const releaseNotesPath = path.posix.join(settings.docsDirectory, `v${semver}-RELEASE-NOTES.md`);
    await gitHelper.writeWorkspaceFile(releaseNotesPath, releaseNotes);

    report("Committing…");
    const committed = await gitHelper.commitAllChanges(`chore(2gp): prepare v${semver} beta from ${source}`);
    if (!committed) {
        throw new Error("Nothing to commit after segregation — check sfDevops.packaging paths match your project layout.");
    }

    report(`Pushing ${branchName}…`);
    await gitHelper.pushNewBranch(branchName);

    report("Opening pull request…");
    let prUrl: string | undefined;
    // sfDevops.repoWorkspace/repoSlug are optional — resolveRepoIdentity derives the repo
    // identity from the origin remote when they're unset, so PR creation doesn't silently
    // no-op on a normal setup (same fallback the day-to-day Promote & Deploy flow uses).
    const repoOverride = await gitHelper.resolveRepoIdentity(providerClient);

    const created = await providerClient.createPullRequest(branchName, baseline, `2GP Beta v${semver}`, releaseNotes, repoOverride);
    if (created) {
        prUrl = created.url;
    } else {
        const fallback = providerClient.buildPrUrl(branchName, baseline, repoOverride);
        if (fallback) { prUrl = fallback; }
    }

    return {
        branch: branchName,
        version: full,
        managedFiles: managed.map(f => f.sourcePath),
        unmanagedFiles: unmanaged.map(f => f.sourcePath),
        excludedFiles: excluded,
        deletedFiles: deleted,
        releaseNotesPath,
        releaseNotes,
        prUrl,
    };
}
