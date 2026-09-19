// cleanIgnoredFiles.ts — "Clean Ignored Files from Git" command
// One-time cleanup for files that were committed before being added to .gitignore. Since
// .gitignore can't retroactively untrack an already-committed file, these otherwise stay
// tracked forever, permanently tripping every uncommitted-changes gate (Promote/Validate/
// Deploy/Resume) and getting re-staged by every commit. This shows the user exactly which
// files that is, lets them confirm, then untracks them (content stays on disk) in one
// dedicated commit.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";

export async function cleanIgnoredFiles(gitHelper: GitHelper): Promise<void> {
    const files = await gitHelper.trackedIgnoredFiles();
    if (files.length === 0) {
        vscode.window.showInformationMessage("Nothing to clean up — no tracked files match .gitignore.");
        return;
    }

    const preview = files.slice(0, 10).join("\n");
    const more = files.length > 10 ? `\n...and ${files.length - 10} more` : "";
    const choice = await vscode.window.showWarningMessage(
        `${files.length} file(s) are tracked in git but match .gitignore:\n\n${preview}${more}\n\n` +
        `Untracking them stops them from ever being staged or blocking a commit/promotion again. Their contents stay on disk.`,
        { modal: true },
        "Untrack These Files"
    );
    if (choice !== "Untrack These Files") { return; }

    await gitHelper.untrackIgnoredFiles(files);
    vscode.window.showInformationMessage(`Untracked ${files.length} file(s) matched by .gitignore — push when ready.`);
}
