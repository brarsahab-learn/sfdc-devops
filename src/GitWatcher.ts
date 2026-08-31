// GitWatcher.ts — reacts to git repository state changing OUTSIDE this extension's own
// commands (a branch switch via Source Control/terminal/another tool, a commit, staging a
// file) by hooking into VS Code's built-in Git extension, instead of leaving the sidebar to
// go stale until its next 60s poll. Degrades to a no-op if that extension isn't available —
// every existing polling/manual-refresh path keeps working unchanged either way.

import * as vscode from "vscode";
import { debugLog } from "./Log";

const DEBOUNCE_MS = 300;

/**
 * Calls `onChange` (debounced) whenever the workspace's git repository state changes — branch
 * switch, commit, stage/unstage, etc. `onChange` receives the current HEAD branch name (or
 * undefined if detached/unknown). Returns a disposable; safe to call even if the built-in git
 * extension isn't present or hasn't found a repository yet (resolves lazily via
 * `onDidOpenRepository`).
 */
export function watchGitState(
    workspaceRoot: string,
    onChange: (branch: string | undefined) => void
): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    let debounceTimer: NodeJS.Timeout | undefined;

    const fire = (branch: string | undefined) => {
        if (debounceTimer) { clearTimeout(debounceTimer); }
        debounceTimer = setTimeout(() => onChange(branch), DEBOUNCE_MS);
    };

    const attach = (repo: any) => {
        if (!repo || String(repo.rootUri?.fsPath ?? "") !== workspaceRoot) { return false; }
        disposables.push(repo.state.onDidChange(() => fire(repo.state.HEAD?.name)));
        debugLog(`GitWatcher attached to repository at ${workspaceRoot}`);
        return true;
    };

    try {
        const gitExt = vscode.extensions.getExtension("vscode.git");
        if (!gitExt) {
            debugLog("GitWatcher: built-in vscode.git extension not found — falling back to polling only.");
            return new vscode.Disposable(() => {});
        }
        const ready = gitExt.isActive ? Promise.resolve(gitExt.exports) : gitExt.activate();
        ready.then((exports: any) => {
            const api = exports.getAPI(1);
            const attachedAlready = api.repositories.some(attach);
            if (!attachedAlready) {
                disposables.push(api.onDidOpenRepository((repo: any) => attach(repo)));
            }
        }, (err: any) => {
            debugLog(`GitWatcher: could not activate vscode.git — ${err?.message ?? err}`);
        });
    } catch (err: any) {
        debugLog(`GitWatcher: setup failed — ${err?.message ?? err}`);
    }

    return new vscode.Disposable(() => {
        if (debounceTimer) { clearTimeout(debounceTimer); }
        disposables.forEach(d => d.dispose());
    });
}
