"use strict";
// GitWatcher.ts — reacts to git repository state changing OUTSIDE this extension's own
// commands (a branch switch via Source Control/terminal/another tool, a commit, staging a
// file) by hooking into VS Code's built-in Git extension, instead of leaving the sidebar to
// go stale until its next 60s poll. Degrades to a no-op if that extension isn't available —
// every existing polling/manual-refresh path keeps working unchanged either way.
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
exports.watchGitState = watchGitState;
const vscode = __importStar(require("vscode"));
const Log_1 = require("./Log");
const DEBOUNCE_MS = 300;
/**
 * Calls `onChange` (debounced) whenever the workspace's git repository state changes — branch
 * switch, commit, stage/unstage, etc. `onChange` receives the current HEAD branch name (or
 * undefined if detached/unknown). Returns a disposable; safe to call even if the built-in git
 * extension isn't present or hasn't found a repository yet (resolves lazily via
 * `onDidOpenRepository`).
 */
function watchGitState(workspaceRoot, onChange) {
    const disposables = [];
    let debounceTimer;
    const fire = (branch) => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => onChange(branch), DEBOUNCE_MS);
    };
    const attach = (repo) => {
        if (!repo || String(repo.rootUri?.fsPath ?? "") !== workspaceRoot) {
            return false;
        }
        disposables.push(repo.state.onDidChange(() => fire(repo.state.HEAD?.name)));
        (0, Log_1.debugLog)(`GitWatcher attached to repository at ${workspaceRoot}`);
        return true;
    };
    try {
        const gitExt = vscode.extensions.getExtension("vscode.git");
        if (!gitExt) {
            (0, Log_1.debugLog)("GitWatcher: built-in vscode.git extension not found — falling back to polling only.");
            return new vscode.Disposable(() => { });
        }
        const ready = gitExt.isActive ? Promise.resolve(gitExt.exports) : gitExt.activate();
        ready.then((exports) => {
            const api = exports.getAPI(1);
            const attachedAlready = api.repositories.some(attach);
            if (!attachedAlready) {
                disposables.push(api.onDidOpenRepository((repo) => attach(repo)));
            }
        }, (err) => {
            (0, Log_1.debugLog)(`GitWatcher: could not activate vscode.git — ${err?.message ?? err}`);
        });
    }
    catch (err) {
        (0, Log_1.debugLog)(`GitWatcher: setup failed — ${err?.message ?? err}`);
    }
    return new vscode.Disposable(() => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        disposables.forEach(d => d.dispose());
    });
}
//# sourceMappingURL=GitWatcher.js.map