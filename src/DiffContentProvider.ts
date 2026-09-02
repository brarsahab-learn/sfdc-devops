// DiffContentProvider.ts — backs the "Review Changes" diff views (Promote/Validate confirm,
// and anywhere else that wants a real VS Code diff editor for a file at a given git ref)
// with virtual read-only documents, so vscode.diff can compare two branches' content for a
// file without either of them being checked out on disk.

import * as vscode from "vscode";
import { GitHelper } from "./GitHelper";

export const SF_DEVOPS_DIFF_SCHEME = "sfdevops-diff";

export class GitRefContentProvider implements vscode.TextDocumentContentProvider {
    constructor(private readonly _gitHelper: GitHelper) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const ref = new URLSearchParams(uri.query).get("ref") ?? "";
        const filePath = uri.path.replace(/^\//, "");
        // null (file doesn't exist at this ref — added/deleted) renders as an empty
        // document, which vscode.diff correctly shows as a whole-file add/delete.
        return (await this._gitHelper.fileContentAtRef(ref, filePath)) ?? "";
    }
}

/** Builds the two virtual URIs `vscode.diff` needs to compare `filePath` at two different refs. */
export function buildDiffUris(filePath: string, beforeRef: string, afterRef: string): { before: vscode.Uri; after: vscode.Uri } {
    return {
        before: vscode.Uri.parse(`${SF_DEVOPS_DIFF_SCHEME}:/${filePath}?ref=${encodeURIComponent(beforeRef)}`),
        after:  vscode.Uri.parse(`${SF_DEVOPS_DIFF_SCHEME}:/${filePath}?ref=${encodeURIComponent(afterRef)}`),
    };
}
