"use strict";
// cleanIgnoredFiles.ts — "Clean Ignored Files from Git" command
// One-time cleanup for files that were committed before being added to .gitignore. Since
// .gitignore can't retroactively untrack an already-committed file, these otherwise stay
// tracked forever, permanently tripping every uncommitted-changes gate (Promote/Validate/
// Deploy/Resume) and getting re-staged by every commit. This shows the user exactly which
// files that is, lets them confirm, then untracks them (content stays on disk) in one
// dedicated commit.
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
exports.cleanIgnoredFiles = cleanIgnoredFiles;
const vscode = __importStar(require("vscode"));
async function cleanIgnoredFiles(gitHelper) {
    const files = await gitHelper.trackedIgnoredFiles();
    if (files.length === 0) {
        vscode.window.showInformationMessage("Nothing to clean up — no tracked files match .gitignore.");
        return;
    }
    const preview = files.slice(0, 10).join("\n");
    const more = files.length > 10 ? `\n...and ${files.length - 10} more` : "";
    const choice = await vscode.window.showWarningMessage(`${files.length} file(s) are tracked in git but match .gitignore:\n\n${preview}${more}\n\n` +
        `Untracking them stops them from ever being staged or blocking a commit/promotion again. Their contents stay on disk.`, { modal: true }, "Untrack These Files");
    if (choice !== "Untrack These Files") {
        return;
    }
    await gitHelper.untrackIgnoredFiles(files);
    vscode.window.showInformationMessage(`Untracked ${files.length} file(s) matched by .gitignore — push when ready.`);
}
//# sourceMappingURL=cleanIgnoredFiles.js.map