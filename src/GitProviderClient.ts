// GitProviderClient.ts
// Provider-agnostic seam for the Git host (Bitbucket, GitHub, GitLab, Azure DevOps, ...).
// Only Bitbucket is implemented today, but every command talks to this interface —
// not to BitbucketClient directly — so adding a provider is additive, not a rewrite.

import * as vscode from "vscode";
import { getGitProvider } from "./config";
import { BitbucketClient } from "./BitbucketClient";

export interface PipelineRun {
    id:        number;
    state:     string;
    result:    string;
    branch:    string;
    commit:    string;
    url:       string;
    createdOn: string;
}

export interface IGitProviderClient {
    /** State of a PR from sourceBranch -> destinationBranch, using stored credentials if available. */
    getPRState(sourceBranch: string, destinationBranch: string): Promise<"open" | "merged" | "none" | "pipeline_running">;

    /** Most recent pipeline/workflow runs for the repo. */
    getLatestPipelines(limit?: number): Promise<PipelineRun[]>;

    /**
     * Builds the "create a pull/merge request" URL for source -> destination, opened in
     * the browser. Uses the configured repo identity unless `repoOverride` is given
     * (e.g. derived from the `origin` remote URL when settings are unset). Returns ""
     * if no repo identity is available either way.
     */
    buildPrUrl(sourceBranch: string, destinationBranch: string, repoOverride?: { workspace: string; repoSlug: string }): string;

    /** Parses an `origin` remote URL for this provider; null if it doesn't match. */
    parseRemoteUrl(remoteUrl: string): { workspace: string; repoSlug: string } | null;
}

const registry: Record<string, new (context: vscode.ExtensionContext) => IGitProviderClient> = {
    bitbucket: BitbucketClient,
};

/**
 * Instantiates the client for the configured sfDevops.gitProvider.
 * Unknown/unimplemented providers fall back to Bitbucket with a one-time warning rather
 * than crashing the extension, since most commands degrade gracefully without a client.
 */
export function createGitProviderClient(context: vscode.ExtensionContext): IGitProviderClient {
    const provider = getGitProvider();
    const ClientClass = registry[provider];
    if (!ClientClass) {
        vscode.window.showWarningMessage(
            `sfDevops.gitProvider is set to "${provider}", which isn't implemented yet. ` +
            `Falling back to Bitbucket. Supported providers: ${Object.keys(registry).join(", ")}.`
        );
        return new BitbucketClient(context);
    }
    return new ClientClass(context);
}
