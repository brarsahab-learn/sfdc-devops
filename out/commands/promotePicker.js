"use strict";
// promotePicker.ts — "Promote to {env}" entry point.
// Shows every story sitting on the previous stage's branch that hasn't been promoted to
// the target stage yet, and lets the user pick one — works regardless of which branch is
// currently checked out, unlike the old flow which silently acted on whatever feature
// branch happened to be current.
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
exports.promoteViaPicker = promoteViaPicker;
const vscode = __importStar(require("vscode"));
const GitHelper_1 = require("../GitHelper");
const promoteStory_1 = require("./promoteStory");
const DeploymentPlanner_1 = require("../DeploymentPlanner");
const config_1 = require("../config");
async function findPromotionCandidates(gitHelper, prevBranch, targetBranch) {
    let commits;
    try {
        commits = await gitHelper.commitLogBetween(targetBranch, prevBranch);
    }
    catch {
        throw new Error(`Could not compare ${prevBranch} against ${targetBranch} — check both branches exist on origin.`);
    }
    const byStory = (0, DeploymentPlanner_1.distinctStoryIdsFromCommits)(commits, (0, config_1.getTicketKeyPattern)());
    const out = [];
    for (const [storyId, storyCommits] of byStory) {
        // Greps the whole target-branch history for the story id — survives squash-merges
        // (which replace the commit message with the PR title, not the raw squash commit).
        const alreadyOnTarget = await gitHelper.storyCommitShaOnBranch(targetBranch, storyId);
        if (alreadyOnTarget) {
            continue;
        }
        const latest = storyCommits[0]; // git log is newest-first
        out.push({ storyId, commitCount: storyCommits.length, lastDate: latest.date, lastMessage: latest.message });
    }
    return out.sort((a, b) => a.storyId.localeCompare(b.storyId));
}
async function promoteViaPicker(bbClient, gitHelper, targetEnv, storyProvider) {
    const envCfg = (0, config_1.findEnvironment)(targetEnv);
    if (!envCfg) {
        vscode.window.showErrorMessage(`Unknown environment "${targetEnv}" — check sfDevops.environments.`);
        return;
    }
    await gitHelper.fetchRemote();
    const promotable = (0, config_1.getPromotableEnvironments)();
    const idx = promotable.findIndex(e => e.name === targetEnv);
    const prevEnv = idx > 0 ? promotable[idx - 1] : (0, config_1.getPublishEnvironment)();
    // Same hard gate as Deploy/Validate and the direct promote command — enforced again
    // here so the picker can never be used to bypass it, even though runPromotion (called
    // below once a story is picked) also enforces it independently.
    if (idx > 0) {
        const gap = await gitHelper.checkPrevEnvDeployed(prevEnv, envCfg.label);
        if (gap.blocked) {
            vscode.window.showWarningMessage(gap.reason);
            return;
        }
    }
    let candidates;
    try {
        candidates = await findPromotionCandidates(gitHelper, prevEnv.branch, envCfg.branch);
    }
    catch (err) {
        vscode.window.showErrorMessage(String(err));
        return;
    }
    if (candidates.length === 0) {
        vscode.window.showInformationMessage(`Nothing to promote to ${envCfg.label} — every story on ${prevEnv.label} has already been promoted here.`);
        return;
    }
    const items = candidates.map(c => ({
        label: c.storyId,
        description: `${c.commitCount} commit(s)`,
        detail: `${c.lastDate.slice(0, 10)} — ${c.lastMessage}`,
        storyId: c.storyId,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: `Promote to ${envCfg.label}`,
        placeHolder: `Select a story currently on ${prevEnv.label} to promote to ${envCfg.label}`,
    });
    if (!picked) {
        return;
    }
    await promoteSelectedStory(bbClient, gitHelper, picked.storyId, targetEnv, storyProvider);
}
/**
 * Runs the existing promotion flow for an explicitly chosen story, from whatever branch
 * happens to be checked out — beginPromotion/finalizeAndFinish always end by checking out
 * the PROMOTED story's feature branch (never the one you started on), so this restores
 * the original branch afterward, mirroring the same originalBranch/checkoutBranch pattern
 * DeploymentDashboardPanel._runAction already uses for its own temporary branch switches.
 */
async function promoteSelectedStory(bbClient, gitHelper, storyId, targetEnv, storyProvider) {
    if (await gitHelper.hasUncommittedChanges()) {
        await (0, GitHelper_1.warnUncommittedChanges)(gitHelper, `Commit or stash your local changes before promoting ${storyId} — this checks out other branches temporarily.`);
        return;
    }
    const originalBranch = await gitHelper.currentBranch();
    try {
        await (0, promoteStory_1.runPromotion)(bbClient, gitHelper, storyId, targetEnv, "promote", storyProvider);
    }
    finally {
        if (originalBranch) {
            await gitHelper.checkoutBranch(originalBranch).catch(() => { });
        }
        storyProvider.refresh();
    }
}
//# sourceMappingURL=promotePicker.js.map