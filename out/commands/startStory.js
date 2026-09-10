"use strict";
// startStory.ts — "Start New Story" command
// Creates a correctly-named feature branch from dev with one prompt
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
exports.startStory = startStory;
const vscode = __importStar(require("vscode"));
const GitHelper_1 = require("../GitHelper");
const config_1 = require("../config");
const StoryProgress_1 = require("../StoryProgress");
async function startStory(bbClient, gitHelper, storyProvider) {
    // Check for uncommitted changes first
    if (await gitHelper.hasUncommittedChanges()) {
        await (0, GitHelper_1.warnUncommittedChanges)(gitHelper, "You have uncommitted changes. Please commit or stash them before starting a new story.");
        return;
    }
    // Doesn't block — just catches the "forgot I had something in flight" case. A team
    // legitimately running multiple stories in parallel can just continue past it.
    const currentBranch = await gitHelper.currentBranch();
    if ((0, config_1.isFeatureBranch)(currentBranch)) {
        const currentStoryId = (0, config_1.extractStoryId)(currentBranch);
        if (currentStoryId) {
            const progress = await (0, StoryProgress_1.getStoryProgress)(gitHelper, bbClient, currentStoryId);
            const pending = (0, config_1.getEnvironments)().filter(e => progress[e.name] === "open" || progress[e.name] === "merged");
            if (pending.length > 0) {
                const summary = pending
                    .map(e => `${e.label} (${progress[e.name] === "merged" ? "merged, not deployed" : "open PR"})`)
                    .join(", ");
                const choice = await vscode.window.showWarningMessage(`${currentStoryId} still has unfinished pipeline work: ${summary}. Starting a new story won't stop it — it'll keep waiting for you (or someone else) to finish.`, { modal: true }, "Continue Anyway");
                if (!choice) {
                    return;
                }
            }
        }
    }
    // Get the story/ticket ID from whichever ticketing system is configured
    // (sfDevops.ticketSystem). Any format is accepted here, including free text
    // (e.g. "IB-123" or an arbitrary description) — sfDevops.ticketKeyPattern is
    // only used later to extract a key back out of a branch name.
    const ticketSystem = (0, config_1.getTicketSystem)();
    const label = ticketSystem === "none" ? "Story ID" : `${ticketSystem[0].toUpperCase()}${ticketSystem.slice(1)} Story ID`;
    const storyId = await vscode.window.showInputBox({
        prompt: `Enter ${label}`,
        placeHolder: ticketSystem === "none" ? "e.g. STORY-101" : "PROJ-123",
        validateInput: (v) => (0, config_1.sanitizeStoryId)(v).length > 0 ? undefined : "Enter a story ID or short description with at least one letter/number",
    });
    if (!storyId) {
        return;
    }
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Creating branch for ${storyId}...`,
        cancellable: false,
    }, async () => {
        const cleanStoryId = (0, config_1.sanitizeStoryId)(storyId).toUpperCase();
        try {
            const branchName = await gitHelper.createFeatureBranch(cleanStoryId);
            await gitHelper.appendAudit({
                operation: "startStory",
                storyId: cleanStoryId,
                branch: branchName,
                outcome: "success",
                summary: `Created and pushed ${branchName}`,
            });
            const repoOverride = await gitHelper.resolveRepoIdentity(bbClient);
            const branchUrl = bbClient.buildBranchUrl(branchName, repoOverride);
            vscode.window.showInformationMessage(`✅ Branch created: ${branchName}`, ...(branchUrl ? ["View Branch in Browser"] : []), "Open Terminal").then((choice) => {
                if (choice === "Open Terminal") {
                    vscode.commands.executeCommand("workbench.action.terminal.new");
                }
                else if (choice === "View Branch in Browser" && branchUrl) {
                    vscode.env.openExternal(vscode.Uri.parse(branchUrl));
                }
            });
            storyProvider.refresh();
        }
        catch (err) {
            await gitHelper.appendAudit({
                operation: "startStory",
                storyId: cleanStoryId,
                outcome: "failure",
                summary: "Failed to create branch",
                details: { error: String(err) },
            });
            vscode.window.showErrorMessage(`Failed to create branch: ${err}`);
        }
    });
}
//# sourceMappingURL=startStory.js.map