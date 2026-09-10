"use strict";
// SetupCheck.ts — validates that the basic environment this extension needs is in
// place (git repo, remote, provider identity, required branches, source folder) before
// the story panel lets the user start working. Provider credentials are checked too,
// but only as a non-blocking recommendation — PR creation already falls back to a
// browser flow without them.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSetupChecks = runSetupChecks;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const SfCli_1 = require("./SfCli");
const config_1 = require("./config");
const PROVIDER_TOKEN_SECRET = {
    bitbucket: "sfDevops.bbToken",
    github: "sfDevops.ghToken",
};
async function runSetupChecks(gitHelper, providerClient, context, effectiveRole = "Developer") {
    const items = [];
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
    const settingsIdentity = (0, config_1.getRepoWorkspace)() && (0, config_1.getRepoSlug)();
    const derivedIdentity = remoteUrl ? providerClient.parseRemoteUrl(remoteUrl) : null;
    const identityResolved = Boolean(settingsIdentity || derivedIdentity);
    items.push({
        key: "repoIdentity", label: `Repo identity resolvable (${provider})`, required: true,
        passed: identityResolved,
        detail: identityResolved
            ? (settingsIdentity ? "From sfDevops.repoWorkspace / sfDevops.repoSlug" : `Derived from origin: ${derivedIdentity.workspace}/${derivedIdentity.repoSlug}`)
            : `Could not determine the ${provider} workspace/repo slug from settings or the origin URL.`,
        fixSteps: identityResolved ? [] : [
            "Set sfDevops.repoWorkspace and sfDevops.repoSlug in Settings, or",
            `Make sure the origin remote URL matches the ${provider} URL shape (e.g. https://${provider === "github" ? "github.com" : "bitbucket.org"}/<workspace>/<repo>.git).`,
            "Check sfDevops.gitProvider is set to the correct provider.",
        ],
    });
    const base = (0, config_1.getBaseBranch)();
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
    const environments = (0, config_1.getEnvironments)();
    const envChecks = await Promise.all(environments.map(async (e) => ({ env: e, exists: await gitHelper.remoteBranchExists(e.branch) })));
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
        missingEnvBranches: missingEnvs.map(m => ({ branch: m.env.branch, label: m.env.label })),
    });
    const sourceRoot = (0, config_1.getSourceRootFolder)();
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
    // --- Salesforce CLI (sf) check ---
    const sfCliPassed = await new Promise((resolve) => {
        (0, child_process_1.execFile)("sf", ["version", "--json"], (err) => { resolve(!err); });
    });
    items.push({
        key: "sfCli", label: "Salesforce CLI (sf)", required: true,
        passed: sfCliPassed,
        detail: sfCliPassed ? "sf CLI is installed and accessible." : "The `sf` CLI was not found on your PATH.",
        fixSteps: sfCliPassed ? [] : [
            "Install the Salesforce CLI: https://developer.salesforce.com/tools/salesforcecli",
            "Restart VS Code after installation.",
        ],
    });
    // --- sfdx-project.json check ---
    const workspaceRoot = gitHelper.getWorkspaceRoot();
    const sfdxProjectPath = path.join(workspaceRoot, "sfdx-project.json");
    const sfdxProjectExists = fs.existsSync(sfdxProjectPath);
    let sfdxPassed = sfdxProjectExists;
    let sfdxRequired = true;
    let sfdxDetail;
    let sfdxFixSteps;
    if (!sfdxProjectExists) {
        sfdxDetail = "sfdx-project.json was not found in the workspace root.";
        sfdxFixSteps = [
            "Create an sfdx-project.json in your workspace root.",
            "Run: sf project generate --name <project> to scaffold one.",
        ];
    }
    else {
        try {
            const parsed = JSON.parse(fs.readFileSync(sfdxProjectPath, "utf8"));
            if (!Array.isArray(parsed.packageDirectories) || parsed.packageDirectories.length === 0) {
                sfdxPassed = false;
                sfdxRequired = false;
                sfdxDetail = "sfdx-project.json exists but packageDirectories is missing or empty.";
                sfdxFixSteps = ["Add at least one entry to packageDirectories in sfdx-project.json."];
            }
            else {
                sfdxDetail = `sfdx-project.json found with ${parsed.packageDirectories.length} package director${parsed.packageDirectories.length === 1 ? "y" : "ies"}.`;
                sfdxFixSteps = [];
            }
        }
        catch {
            sfdxPassed = false;
            sfdxRequired = false;
            sfdxDetail = "sfdx-project.json exists but could not be parsed as valid JSON.";
            sfdxFixSteps = ["Ensure sfdx-project.json is valid JSON."];
        }
    }
    items.push({
        key: "sfdxProject", label: "sfdx-project.json", required: sfdxRequired,
        passed: sfdxPassed,
        detail: sfdxDetail,
        fixSteps: sfdxFixSteps,
    });
    // --- Git user identity check ---
    const gitUserEmail = await new Promise((resolve) => {
        (0, child_process_1.execFile)("git", ["config", "user.email"], { cwd: workspaceRoot }, (err, stdout) => {
            resolve(err ? "" : stdout.trim());
        });
    });
    items.push({
        key: "gitUserIdentity", label: "Git user identity", required: false,
        passed: Boolean(gitUserEmail),
        detail: gitUserEmail
            ? `Git user email is set to: ${gitUserEmail}`
            : "No git user.email configured — commits may be anonymous.",
        fixSteps: gitUserEmail ? [] : [
            "Run: git config --global user.email 'you@example.com'",
            "Run: git config --global user.name 'Your Name'",
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
function getRequiredOrgSlotKeys(effectiveRole) {
    const envs = (0, config_1.getEnvironments)();
    const roles = (0, config_1.getRoles)();
    const roleRank = roles.indexOf(effectiveRole);
    const required = new Set();
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
async function checkOrgAuthentication(workspaceRoot, effectiveRole = "Developer") {
    const slots = (0, config_1.getOrgAliasSlots)();
    const requiredKeys = getRequiredOrgSlotKeys(effectiveRole);
    const slotNames = slots.map(s => s.label).join("/");
    const base = { key: "orgAuthentication", label: `Configured org aliases authenticated (${slotNames})`, required: true };
    const unset = slots.filter(s => !s.alias);
    const toCheck = slots.filter(s => s.alias);
    const results = await Promise.all(toCheck.map(async (s) => ({ slot: s, connected: await (0, SfCli_1.isOrgConnected)(s.alias, workspaceRoot) })));
    const connectedAliases = {};
    for (const s of slots) {
        connectedAliases[s.key] = s.alias ? Boolean(results.find(r => r.slot.key === s.key)?.connected) : false;
    }
    const requiredUnset = unset.filter(s => requiredKeys.has(s.key));
    const requiredNotAuthed = results.filter(r => requiredKeys.has(r.slot.key) && !r.connected).map(r => r.slot);
    const passed = requiredUnset.length === 0 && requiredNotAuthed.length === 0;
    const problems = [
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
function skippedItems() {
    const skippedDetail = "Skipped — fix the git repository check above first.";
    return [
        { key: "originRemote", label: "\"origin\" remote configured", required: true, passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "repoIdentity", label: "Repo identity resolvable", required: true, passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "baseBranch", label: "Base branch exists on origin", required: true, passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "environmentBranches", label: "Configured environment branches exist on origin", required: true, passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "sourceFolder", label: "Source folder present", required: true, passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "orgAuthentication", label: "Configured org aliases authenticated (Dev/QA/UAT/Prod)", required: true, passed: false, detail: skippedDetail, fixSteps: [] },
        { key: "providerCredentials", label: "Provider credentials stored", required: false, passed: false, detail: skippedDetail, fixSteps: [] },
    ];
}
//# sourceMappingURL=SetupCheck.js.map