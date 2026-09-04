// GitProviderClient.ts
// Provider-agnostic seam for the Git host (Bitbucket, GitHub, GitLab, Azure DevOps, ...).
// Only Bitbucket is implemented today, but every command talks to this interface —
// not to BitbucketClient directly — so adding a provider is additive, not a rewrite.

import * as vscode from "vscode";
import { getGitProviderRaw } from "./config";
import { BitbucketClient } from "./BitbucketClient";
import { GitHubClient } from "./GitHubClient";

export interface PipelineRun {
    id:        number;
    state:     string;
    result:    string;
    /** Provider-neutral "did this run succeed" — use this instead of comparing `result` (a raw, provider-specific string like Bitbucket's "SUCCESSFUL" vs GitHub's "success"). */
    succeeded: boolean;
    branch:    string;
    commit:    string;
    url:       string;
    createdOn: string;
}

export interface IGitProviderClient {
    /** Which provider this instance actually talks to — reflects auto-detection, not just the raw setting. */
    readonly providerName: string;

    /** State of a PR from sourceBranch -> destinationBranch, using stored credentials if available. */
    getPRState(sourceBranch: string, destinationBranch: string): Promise<"open" | "merged" | "none" | "pipeline_running">;

    /**
     * The browser URL of the CURRENTLY OPEN PR from sourceBranch -> destinationBranch, or
     * null if there isn't one (none exists, it's already merged, no token is stored, or the
     * API call fails). Silent — same "no token, no prompt" behavior as getPRState — used so
     * clicking Promote on a story that already has an open PR jumps straight to it instead
     * of restarting the create-branch/validate sequence from scratch.
     */
    getOpenPRUrl(sourceBranch: string, destinationBranch: string, repoOverride?: { workspace: string; repoSlug: string }): Promise<string | null>;

    /** Most recent pipeline/workflow runs for the repo. */
    getLatestPipelines(limit?: number): Promise<PipelineRun[]>;

    /**
     * Builds the "create a pull/merge request" URL for source -> destination, opened in
     * the browser. Uses the configured repo identity unless `repoOverride` is given
     * (e.g. derived from the `origin` remote URL when settings are unset). Returns ""
     * if no repo identity is available either way.
     */
    buildPrUrl(sourceBranch: string, destinationBranch: string, repoOverride?: { workspace: string; repoSlug: string }, body?: string): string;

    /** Parses an `origin` remote URL for this provider; null if it doesn't match. */
    parseRemoteUrl(remoteUrl: string): { workspace: string; repoSlug: string } | null;

    /** Builds the "view this branch" URL, opened in the browser. Same repoOverride/"" semantics as buildPrUrl. */
    buildBranchUrl(branch: string, repoOverride?: { workspace: string; repoSlug: string }): string;

    /**
     * Creates a real pull request via the provider's API (used by the 2GP Packaging
     * Release Gate, which needs the generated release notes injected into the PR body —
     * not just a prefilled browser form). Prompts for credentials if none are stored yet.
     * Returns null if the repo identity is unknown or the API call fails; callers should
     * fall back to buildPrUrl() + opening the browser in that case.
     */
    createPullRequest(
        sourceBranch:      string,
        destinationBranch: string,
        title:             string,
        body:              string,
        repoOverride?:     { workspace: string; repoSlug: string }
    ): Promise<{ url: string } | null>;
}

const registry: Record<string, new (context: vscode.ExtensionContext) => IGitProviderClient> = {
    bitbucket: BitbucketClient,
    github:    GitHubClient,
};

/** Guesses the provider from the `origin` remote URL's host — used only when sfDevops.gitProvider is unset. */
function detectProviderFromRemote(remoteUrl?: string | null): string | undefined {
    if (!remoteUrl) { return undefined; }
    if (/github\.com/i.test(remoteUrl))    { return "github"; }
    if (/bitbucket\.org/i.test(remoteUrl)) { return "bitbucket"; }
    return undefined;
}

/**
 * Instantiates the client for sfDevops.gitProvider. An explicit setting always wins; when
 * it's left unset, `remoteUrl` (the repo's `origin` remote, if known) picks the provider
 * instead of silently assuming Bitbucket — so a GitHub-origin repo with no gitProvider set
 * still resolves PR/pipeline status correctly. Unknown/unimplemented explicit values fall
 * back to Bitbucket with a one-time warning rather than crashing the extension.
 */
export function createGitProviderClient(context: vscode.ExtensionContext, remoteUrl?: string | null): IGitProviderClient {
    const explicit = getGitProviderRaw();
    const provider = explicit || detectProviderFromRemote(remoteUrl) || "bitbucket";
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
