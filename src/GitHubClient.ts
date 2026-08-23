// GitHubClient.ts
// GitHub implementation of IGitProviderClient — same status-reads-are-silent,
// PR-creation-prompts-once philosophy as BitbucketClient.ts.

import * as vscode from "vscode";
import { IGitProviderClient, PipelineRun } from "./GitProviderClient";
import { getRepoWorkspace, getRepoSlug } from "./config";

const GH_API = "https://api.github.com";
const GH_WEB = "https://github.com";

export class GitHubClient implements IGitProviderClient {
    constructor(private readonly _context: vscode.ExtensionContext) {}

    private get owner(): string {
        return getRepoWorkspace();
    }

    private get repo(): string {
        return getRepoSlug();
    }

    /** Stored token, or null — never prompts. Used by the silent status reads below. */
    private async getToken(): Promise<string | null> {
        return (await this._context.secrets.get("sfDevops.ghToken")) || null;
    }

    /** Like getToken(), but prompts for a Personal Access Token (once, then stored) if none exists. */
    private async getOrPromptToken(): Promise<string | null> {
        const existing = await this.getToken();
        if (existing) { return existing; }

        const token = await vscode.window.showInputBox({
            prompt: "GitHub Personal Access Token (needs the \"repo\" scope) — used to create the 2GP beta pull request",
            password: true,
            ignoreFocusOut: true,
        });
        if (!token) { return null; }
        await this._context.secrets.store("sfDevops.ghToken", token);
        return token;
    }

    private async clearToken(): Promise<void> {
        await this._context.secrets.delete("sfDevops.ghToken");
    }

    private async fetch<T>(method: string, path: string, token: string | null, body?: object): Promise<T> {
        const headers: Record<string, string> = { "Accept": "application/vnd.github+json" };
        if (token) { headers["Authorization"] = `Bearer ${token}`; }

        const response = await fetch(`${GH_API}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const err = await response.text();
            if (token && (response.status === 401 || response.status === 403)) { await this.clearToken(); }
            throw new Error(`GitHub API ${response.status}: ${err}`);
        }
        return response.json() as T;
    }

    /** Builds the "Open a pull request" compare URL, prefilled — used as a fallback when no token is available. */
    buildPrUrl(sourceBranch: string, destinationBranch: string, repoOverride?: { workspace: string; repoSlug: string }): string {
        const owner = repoOverride?.workspace || this.owner;
        const repo  = repoOverride?.repoSlug  || this.repo;
        if (!owner || !repo) { return ""; }
        return `${GH_WEB}/${owner}/${repo}/compare/${encodeURIComponent(destinationBranch)}...${encodeURIComponent(sourceBranch)}?expand=1`;
    }

    /** Parses `https://github.com/owner/repo(.git)` or `git@github.com:owner/repo(.git)`. */
    parseRemoteUrl(remoteUrl: string): { workspace: string; repoSlug: string } | null {
        const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
        return m ? { workspace: m[1], repoSlug: m[2] } : null;
    }

    async getPRState(sourceBranch: string, destinationBranch: string): Promise<"open" | "merged" | "none" | "pipeline_running"> {
        if (!this.owner || !this.repo) { return "none"; }
        try {
            const token = await this.getToken();
            const prs = await this.fetch<any[]>(
                "GET",
                `/repos/${this.owner}/${this.repo}/pulls?head=${this.owner}:${sourceBranch}&base=${destinationBranch}&state=all`,
                token
            );
            if (!prs.length) { return "none"; }
            const latest = prs[0];
            if (latest.merged_at) { return "merged"; }
            if (latest.state === "open") { return "open"; }
        } catch {
            return "none";
        }
        return "none";
    }

    async getLatestPipelines(limit = 10): Promise<PipelineRun[]> {
        if (!this.owner || !this.repo) { return []; }
        try {
            const token = await this.getToken();
            const result = await this.fetch<any>(
                "GET",
                `/repos/${this.owner}/${this.repo}/actions/runs?per_page=${limit}`,
                token
            );
            return (result.workflow_runs ?? []).map((r: any): PipelineRun => ({
                id:        r.run_number,
                state:     r.status ?? "unknown",
                result:    r.conclusion ?? "",
                branch:    r.head_branch ?? "",
                commit:    (r.head_sha ?? "").slice(0, 8),
                url:       r.html_url ?? `${GH_WEB}/${this.owner}/${this.repo}/actions`,
                createdOn: r.created_at,
            }));
        } catch {
            return [];
        }
    }

    /** Creates a real PR via the GitHub API (used by the 2GP Packaging Release Gate). */
    async createPullRequest(
        sourceBranch:      string,
        destinationBranch: string,
        title:             string,
        body:              string,
        repoOverride?:     { workspace: string; repoSlug: string }
    ): Promise<{ url: string } | null> {
        const owner = repoOverride?.workspace || this.owner;
        const repo  = repoOverride?.repoSlug  || this.repo;
        if (!owner || !repo) { return null; }

        const token = await this.getOrPromptToken();
        if (!token) { return null; }

        try {
            const pr = await this.fetch<any>(
                "POST",
                `/repos/${owner}/${repo}/pulls`,
                token,
                { title, body, head: sourceBranch, base: destinationBranch }
            );
            return { url: pr.html_url };
        } catch (err) {
            vscode.window.showWarningMessage(`Could not create the GitHub PR automatically: ${err}`);
            return null;
        }
    }
}
