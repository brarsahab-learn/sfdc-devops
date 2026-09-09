"use strict";
// DiffContentProvider.ts — backs the "Review Changes" diff views (Promote/Validate confirm,
// and anywhere else that wants a real VS Code diff editor for a file at a given git ref)
// with virtual read-only documents, so vscode.diff can compare two branches' content for a
// file without either of them being checked out on disk.
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
exports.GitRefContentProvider = exports.SF_DEVOPS_DIFF_SCHEME = void 0;
exports.buildDiffUris = buildDiffUris;
const vscode = __importStar(require("vscode"));
exports.SF_DEVOPS_DIFF_SCHEME = "sfdevops-diff";
class GitRefContentProvider {
    constructor(_gitHelper) {
        this._gitHelper = _gitHelper;
    }
    async provideTextDocumentContent(uri) {
        const ref = new URLSearchParams(uri.query).get("ref") ?? "";
        const filePath = uri.path.replace(/^\//, "");
        // null (file doesn't exist at this ref — added/deleted) renders as an empty
        // document, which vscode.diff correctly shows as a whole-file add/delete.
        return (await this._gitHelper.fileContentAtRef(ref, filePath)) ?? "";
    }
}
exports.GitRefContentProvider = GitRefContentProvider;
/** Builds the two virtual URIs `vscode.diff` needs to compare `filePath` at two different refs. */
function buildDiffUris(filePath, beforeRef, afterRef) {
    return {
        before: vscode.Uri.parse(`${exports.SF_DEVOPS_DIFF_SCHEME}:/${filePath}?ref=${encodeURIComponent(beforeRef)}`),
        after: vscode.Uri.parse(`${exports.SF_DEVOPS_DIFF_SCHEME}:/${filePath}?ref=${encodeURIComponent(afterRef)}`),
    };
}
//# sourceMappingURL=DiffContentProvider.js.map