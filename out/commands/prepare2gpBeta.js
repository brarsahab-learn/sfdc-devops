"use strict";
// prepare2gpBeta.ts — "SF-Ops: Prepare 2GP Beta from UAT" command.
// Admin-triggered: diffs UAT against the 2GP packaging baseline, segregates changed
// metadata into managed/unmanaged, generates release notes, bumps the package version,
// and opens a PR targeting the baseline. See PackagingEngine.ts for the mechanics.
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
exports.prepare2gpBetaCommand = prepare2gpBetaCommand;
const vscode = __importStar(require("vscode"));
const GitHelper_1 = require("../GitHelper");
const PackagingEngine_1 = require("../PackagingEngine");
const config_1 = require("../config");
const RoleManager_1 = require("../RoleManager");
const AuditLog_1 = require("../AuditLog");
async function prepare2gpBetaCommand(providerClient, gitHelper, context) {
    const requiredRole = (0, config_1.getPackagingRequiredRole)();
    const currentRole = (0, RoleManager_1.getEffectiveRole)(context);
    if (requiredRole && currentRole !== requiredRole) {
        vscode.window.showWarningMessage(`Preparing a 2GP beta requires the "${requiredRole}" role (sfDevops.packagingRequiredRole). ` +
            `Your role is "${currentRole}".`);
        return;
    }
    if (await gitHelper.hasUncommittedChanges()) {
        await (0, GitHelper_1.warnUncommittedChanges)(gitHelper, "Commit or stash your changes first — this command creates and checks out a new branch.");
        return;
    }
    const baseline = (0, config_1.getPackageBaselineBranch)();
    const source = (0, config_1.getPackagingSourceBranch)();
    const bumpPick = await vscode.window.showQuickPick([
        { label: "Patch", description: "1.2.3 → 1.2.4 (default)", value: "patch" },
        { label: "Minor", description: "1.2.3 → 1.3.0", value: "minor" },
        { label: "Major", description: "1.2.3 → 2.0.0", value: "major" },
    ], { title: "2GP Beta version bump", placeHolder: "How should the package version increment?" });
    if (!bumpPick) {
        return;
    }
    const confirm = await vscode.window.showWarningMessage(`Prepare a 2GP beta from ${source.toUpperCase()}?\n\n` +
        `This will:\n` +
        `• Compare origin/${source} against origin/${baseline}\n` +
        `• Create 2gp-beta/v<version> from origin/${baseline}\n` +
        `• Segregate changed metadata into managed/unmanaged\n` +
        `• Generate release notes and bump the package version (${bumpPick.label.toLowerCase()})\n` +
        `• Commit, push, and open a PR targeting ${baseline}`, { modal: true }, "Yes, prepare beta");
    if (!confirm) {
        return;
    }
    const originalBranch = await gitHelper.currentBranch();
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Preparing 2GP beta from UAT…",
        cancellable: false,
    }, async (progress) => {
        try {
            const result = await (0, PackagingEngine_1.prepare2gpBeta)(gitHelper, providerClient, bumpPick.value, config_1.extractStoryId, (message) => progress.report({ message }));
            const summary = `✅ ${result.branch} pushed — ${result.managedFiles.length} managed, ` +
                `${result.unmanagedFiles.length} unmanaged, ${result.excludedFiles.length} excluded. ` +
                `Release notes: ${result.releaseNotesPath}.`;
            const changedFiles = [
                ...result.managedFiles.map(path => ({ path, change: "modified" })),
                ...result.unmanagedFiles.map(path => ({ path, change: "modified" })),
                ...result.deletedFiles.map(path => ({ path, change: "deleted" })),
            ];
            const { xml: packageXml, unmapped: unmappedFiles } = (0, AuditLog_1.buildPackageXml)(changedFiles);
            await gitHelper.appendAudit({
                operation: "prepare2gpBeta", branch: result.branch, outcome: "success",
                summary: `${result.branch} pushed (v${result.version})`,
                details: {
                    version: result.version, releaseNotesPath: result.releaseNotesPath,
                    prUrl: result.prUrl, changedFiles, packageXml, unmappedFiles,
                },
            });
            if (result.prUrl) {
                const choice = await vscode.window.showInformationMessage(summary, "Open PR");
                if (choice === "Open PR") {
                    await vscode.env.openExternal(vscode.Uri.parse(result.prUrl));
                }
            }
            else {
                vscode.window.showWarningMessage(`${summary} Could not determine a PR URL — open one manually for ${result.branch} → ${baseline}.`);
            }
        }
        catch (err) {
            await gitHelper.appendAudit({
                operation: "prepare2gpBeta", outcome: "failure",
                summary: "Prepare 2GP Beta failed",
                details: { error: String(err) },
            });
            vscode.window.showErrorMessage(`Prepare 2GP Beta failed: ${err}`);
        }
        finally {
            // Best-effort return to wherever the user was — this command isn't part of
            // the feature-branch workflow, so there's no "checkoutFeature" equivalent.
            if (originalBranch) {
                await gitHelper.checkoutBranch(originalBranch).catch(() => { });
            }
        }
    });
}
//# sourceMappingURL=prepare2gpBeta.js.map