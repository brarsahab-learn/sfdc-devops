// SetupCheck.ts — validates that the basic environment this extension needs is in
// place (git repo, remote, provider identity, required branches, source folder) before
// the story panel lets the user start working. Provider credentials are checked too,
// but only as a non-blocking recommendation — PR creation already falls back to a
// browser flow without them.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { isOrgConnected } from "./SfCli";
import { GitHelper } from "./GitHelper";
import { IGitProviderClient } from "./GitProviderClient";
import {
    getBaseBranch, getEnvironments, getSourceRootFolder, getRepoWorkspace, getRepoSlug,
    getOrgAliasSlots, getRoles,
} from "./config";

export interface SetupCheckItem {
    key:       string;
    label:     string;
    required:  boolean;
    passed:    boolean;
    detail:    string;
    fixSteps:  string[];
    /** Only populated on the "orgAuthentication" item — per-slot (dev/qa/uat/prod) connected status. */
    connectedAliases?: Record<string, boolean>;
}

const PROVIDER_TOKEN_SECRET: Record<string, string> = {
    bitbucket: "sfDevops.bbToken",
    github:    "sfDevops.ghToken",
};

export async function runSetupChecks(
    gitHelper: GitHelper,
    providerClient: IGitProviderClient,
    context: vscode.ExtensionContext,
    effectiveRole: string = "Developer"
): Promise<SetupCheckItem[]> {
    const items: SetupCheckItem[] = [];

    const noWorkspaceOpen = (vscode.workspace.workspaceFolders?.length ?? 0) === 0;
    const branch = noWorkspaceOpen ? null : await gitHelper.currentBranch();
    items.push({
        key: "gitRepo", label: "Git repository detected", required: true,
        passed: branch !== null,
        detail: noWorkspaceOpen
            ? "No folder is open in this VS Code window."
            : (branch !== null ? `On branch "${branch}"` : "This workspace folder doesn't look like a git repository."),
        fixSteps: branch !== null ? [] : noWorkspaceOpen
            ? ["Use File > Open Folder... to open the repo you want to work in."]
            : [
                "Open the folder that contains your cloned repo, or run `git init` / `git clone <url>` here.",
                "Make sure `git` is installed and on your PATH.",
            ],
    });

    // Everything below needs a working repo — fetch once so remote-branch checks are current.
    if (branch === null) {
        return [...items, ...skippedItems()];
    }
    await gitHelper.fetchRemote();

    const remoteUrl = await gitHelper.getRemoteUrl();
    items.push({
        key: "originRemote", label: "\"origin\" remote configured", required: true,
        passed: remoteUrl !== null,
        detail: remoteUrl !== null ? remoteUrl : "No `origin` remote is configured for this repo.",
        fixSteps: remoteUrl !== null ? [] : [
            "Run: git remote add origin <your-repo-url>",
        ],
    });

    const provider = providerClient.providerName;
    const settingsIdentity = getRepoWorkspace() && getRepoSlug();
    const derivedIdentity = remoteUrl ? providerClient.parseRemoteUrl(remoteUrl) : null;
    const identityResolved = Boolean(settingsIdentity || derivedIdentity);
    items.push({
        key: "repoIdentity", label: `Repo identity resolvable (${provider})`, required: true,
        passed: identityResolved,
        detail: identityResolved
            ? (settingsIdentity ? "From sfDevops.repoWorkspace / sfDevops.repoSlug" : `Derived from origin: ${derivedIdentity!.workspace}/${derivedIdentity!.repoSlug}`)
            : `Could not determine the ${provider} workspace/repo slug from settings or the origin URL.`,
        fixSteps: identityResolved ? [] : [
            "Set sfDevops.repoWorkspace and sfDevops.repoSlug in Settings, or",
            `Make sure the origin remote URL matches the ${provider} URL shape (e.g. https://${provider === "github" ? "github.com" : "bitbucket.org"}/<workspace>/<repo>.git).`,
            "Check sfDevops.gitProvider is set to the correct provider.",
        ],
    });

    const base = getBaseBranch();
    const baseExists = await gitHelper.remoteBranchExists(base);
    items.push({
        key: "baseBranch", label: `Base branch "${base}" exists on origin`, required: true,
        passed: baseExists,
        detail: baseExists ? `origin/${base} found` : `origin/${base} was not found.`,
        fixSteps: baseExists ? [] : [
            `Push "${base}" to origin, or`,
            "Update sfDevops.baseBranch to the branch new feature branches should be cut from.",
        ],
    });

    const environments = getEnvironments();
    const envChecks = await Promise.all(
        environments.map(async e => ({ env: e, exists: await gitHelper.remoteBranchExists(e.branch) }))
    );
    const missingEnvs = envChecks.filter(c => !c.exists);
    items.push({
        key: "environmentBranches", label: "Configured environment branches exist on origin", required: true,
        passed: missingEnvs.length === 0,
        detail: missingEnvs.length === 0
            ? `All ${environments.length} environment branch(es) found (${environments.map(e => e.branch).join(", ")}).`
            : `Missing on origin: ${missingEnvs.map(m => `${m.env.branch} (${m.env.label})`).join(", ")}.`,
        fixSteps: missingEnvs.length === 0 ? [] : [
            ...missingEnvs.map(m => `Push "${m.env.branch}" to origin for the "${m.env.label}" environment, or`),
            "Update sfDevops.environments to match the branches that actually exist.",
        ],
    });

    const sourceRoot = getSourceRootFolder();
    const sourceFolderExists = fs.existsSync(path.join(gitHelper.getWorkspaceRoot(), sourceRoot));
    items.push({
        key: "sourceFolder", label: `Source folder "${sourceRoot}" present`, required: true,
        passed: sourceFolderExists,
        detail: sourceFolderExists ? `Found ${sourceRoot}/ in the workspace.` : `"${sourceRoot}" was not found in the workspace root.`,
        fixSteps: sourceFolderExists ? [] : [
            `Make sure your Salesforce source (e.g. an sfdx-project.json project) is checked out at the workspace root, or`,
            "Update sfDevops.sourceRootFolder to match your project's actual source folder name.",
        ],
    });

    items.push(await checkOrgAuthentication(gitHelper.getWorkspaceRoot(), effectiveRole));

    const tokenKey = PROVIDER_TOKEN_SECRET[provider];
    const hasToken = tokenKey ? Boolean(await context.secrets.get(tokenKey)) : false;
    items.push({
        key: "providerCredentials", label: `${provider[0].toUpperCase()}${provider.slice(1)} credentials stored`, required: false,
        passed: hasToken,
        detail: hasToken
            ? "A stored token was found — live PR/pipeline status will work."
            : "No token stored yet. Pull request creation still works by opening a prefilled browser page; live PR/pipeline status needs a token.",
        fixSteps: hasToken ? [] : [
            "Run any action that talks to the provider API (e.g. Promote & Deploy) — you'll be prompted to enter a token once, then it's stored securely.",
        ],
    });

    return items;
}

/**
 * Returns the set of environment slot keys that MUST be authenticated for the given role.
 * Developer: only the first (publish/dev) environment.
 * Lead: first env + any env whose requiredRole rank ≤ Lead's rank.
 * Admin: all environments.
 */
function getRequiredOrgSlotKeys(effectiveRole: string): Set<string> {
    const envs = getEnvironments();
    const roles = getRoles();
    const roleRank = roles.indexOf(effectiveRole);
    const required = new Set<string>();

    envs.forEach((env, idx) => {
        if (idx === 0) {
            required.add(env.name);
            return;
        }
        if (!env.requiredRole) {
            required.add(env.name);
            return;
        }
        const reqRank = roles.indexOf(env.requiredRole);
        if (reqRank === -1 || roleRank >= reqRank) {
            required.add(env.name);
        }
    });

    return required;
}

/**
 * Required: org aliases needed for the given role must have an alias set AND be currently
 * authenticated. Checks each slot individually via `sf org display` (run in parallel).
 */
async function checkOrgAuthentication(workspaceRoot: string, effectiveRole: string = "Developer"): Promise<SetupCheckItem> {
    const slots = getOrgAliasSlots();
    const requiredKeys = getRequiredOrgSlotKeys(effectiveRole);
    const slotNames = slots.map(s => s.label).join("/");
    const base = { key: "orgAuthentication", label: `Configured org aliases authenticated (${slotNames})`, required: true };

    const unset = slots.filter(s => !s.alias);
    const toCheck = slots.filter(s => s.alias);
    const results = await Promise.all(toCheck.map(async s => ({ slot: s, connected: await isOrgConnected(s.alias, workspaceRoot) })));

    const connectedAliases: Record<string, boolean> = {};
    for (const s of slots) { connectedAliases[s.key] = s.alias ? Boolean(results.find(r => r.slot.key === s.key)?.connected) : false; }

    const requiredUnset     = unset.filter(s => requiredKeys.has(s.key));
    const requiredNotAuthed = results.filter(r => requiredKeys.has(r.slot.key) && !r.connected).map(r => r.slot);
    const passed = requiredUnset.length === 0 && requiredNotAuthed.length === 0;

    const problems: string[] = [
        ...requiredUnset.map(s => `${s.label}: no alias set (required for ${effectiveRole})`),
        ...requiredNotAuthed.map(s => `${s.label} (${s.alias}): not authenticated (required for ${effectiveRole})`),
    ];

    const infoProblems = [
        ...unset.filter(s => !requiredKeys.has(s.key)).map(s => `${s.label}: no alias set (optional for ${effectiveRole})`),
        ...results.filter(r => !requiredKeys.has(r.slot.key) && !r.connected).map(r => `${r.slot.label}: not authenticated (optional for ${effectiveRole})`),
    ];

    return {
        ...base,
        passed,
        detail: passed
            ? `Required org alias(es) configured and authenticated for ${effectiveRole}.${infoProblems.length > 0 ? ` (Optional: ${infoProblems.join("; ")})` : ""}`
            : problems.join("; "),
        fixSteps: passed ? [] : [
            "Fill in and authenticate each required org below (Setup Check panel), or",
            ...requiredNotAuthed.map(s => `Run: sf org login web --alias ${s.alias}`),
        ],
        connectedAliases,
    };
}

/** Everything after the git-repo check depends on a working repo — report the rest as failed-but-explained. */
function skippedItems(): SetupCheckItem[] {
    const skippedDetail = "Skipped — fix the git repository check above first.";
    return [
        { key: "originRemote",         label: "\"origin\" remote configured",                     required: true,  passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "repoIdentity",         label: "Repo identity resolvable",                          required: true,  passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "baseBranch",           label: "Base branch exists on origin",                      required: true,  passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "environmentBranches",  label: "Configured environment branches exist on origin",   required: true,  passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "sourceFolder",         label: "Source folder present",                             required: true,  passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "orgAuthentication",    label: "Configured org aliases authenticated (Dev/QA/UAT/Prod)", required: true,  passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "providerCredentials",  label: "Provider credentials stored",                        required: false, passed: false, detail: skippedDetail, fixSteps: [] },
    ];
}
