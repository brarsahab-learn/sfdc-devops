// BitbucketClient.ts
// Handles all Bitbucket REST API calls.
// Status reads are silent; credentials are only prompted when creating a PR.
// Supports Bitbucket's current auth: Repository/Workspace Access Token (Bearer)
// or Atlassian API token (Basic with your Atlassian email). App passwords are deprecated.

import * as vscode from "vscode";
import { IGitProviderClient, PipelineRun } from "./GitProviderClient";
import { getRepoWorkspace, getRepoSlug } from "./config";

const BB_API = "https://api.bitbucket.org/2.0";
const BB_WEB = "https://bitbucket.org";

export class BitbucketClient implements IGitProviderClient {
    readonly providerName = "bitbucket";
    private _authHeader: string | undefined;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    // ── Auth ──────────────────────────────────────────────────────────────────
    // Status reads only, and always silent — never prompts.
    // PR creation happens in the browser, so the extension needs no token/app password.
    private async getAuthHeader(): Promise<string> {
        if (this._authHeader) { return this._authHeader; }

        const token = await this._context.secrets.get("sfDevops.bbToken");
        const email = await this._context.secrets.get("sfDevops.bbEmail");
        if (!token) {
            throw new Error("No Bitbucket credentials available for status.");
        }

        // API token → Basic(email:token); Access token → Bearer(token).
        this._authHeader = email
            ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
            : `Bearer ${token}`;
        return this._authHeader;
    }

    /** Clears stored credentials (on genuine auth failure or wrong scheme). */
    private async clearCredentials(): Promise<void> {
        this._authHeader = undefined;
        await this._context.secrets.delete("sfDevops.bbToken");
        await this._context.secrets.delete("sfDevops.bbEmail");
        await this._context.secrets.delete("sfDevops.bbUsername"); // legacy key from older builds
    }

    /**
     * Like getAuthHeader(), but prompts for a token (once, then stored) if none exists yet.
     * Used only by createPullRequest — an explicit, user-initiated action — never by the
     * silent status reads above.
     */
    private async getOrPromptAuthHeader(): Promise<string | null> {
        try {
            return await this.getAuthHeader();
        } catch {
            const token = await vscode.window.showInputBox({
                prompt: "Bitbucket Repository/Workspace Access Token (or Atlassian API token)",
                password: true,
                ignoreFocusOut: true,
            });
            if (!token) { return null; }
            const email = await vscode.window.showInputBox({
                prompt: "Atlassian account email (leave empty if using a Bitbucket Access Token)",
                ignoreFocusOut: true,
            });
            await this._context.secrets.store("sfDevops.bbToken", token);
            if (email) { await this._context.secrets.store("sfDevops.bbEmail", email); }
            this._authHeader = email
                ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
                : `Bearer ${token}`;
            return this._authHeader;
        }
    }

    private get workspace(): string {
        return getRepoWorkspace();
    }

    private get repoSlug(): string {
        return getRepoSlug();
    }

    /** Builds the "create pull request" URL for source -> destination, opened in the browser. */
    buildPrUrl(sourceBranch: string, destinationBranch: string, repoOverride?: { workspace: string; repoSlug: string }): string {
        const workspace = repoOverride?.workspace || this.workspace;
        const repoSlug  = repoOverride?.repoSlug  || this.repoSlug;
        if (!workspace || !repoSlug) { return ""; }
        return `${BB_WEB}/${workspace}/${repoSlug}/pull-requests/new` +
            `?source=${encodeURIComponent(sourceBranch)}` +
            `&dest=${encodeURIComponent(destinationBranch)}`;
    }

    /** Parses `https://bitbucket.org/ws/repo(.git)` or `git@bitbucket.org:ws/repo(.git)`. */
    parseRemoteUrl(remoteUrl: string): { workspace: string; repoSlug: string } | null {
        const m = remoteUrl.match(/bitbucket\.org[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
        return m ? { workspace: m[1], repoSlug: m[2] } : null;
    }

    /** Builds the "view this branch" URL for the browser. */
    buildBranchUrl(branch: string, repoOverride?: { workspace: string; repoSlug: string }): string {
        const workspace = repoOverride?.workspace || this.workspace;
        const repoSlug  = repoOverride?.repoSlug  || this.repoSlug;
        if (!workspace || !repoSlug) { return ""; }
        return `${BB_WEB}/${workspace}/${repoSlug}/branch/${encodeURIComponent(branch)}`;
    }

    private async fetch<T>(
        method: string,
        path: string,
        body?: object
    ): Promise<T> {
        const auth = await this.getAuthHeader();
        const url  = `${BB_API}${path}`;
        const headers: Record<string, string> = {
            "Authorization": auth,
            "Content-Type":  "application/json",
        };

        const response = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
            const err = await response.text();
            // Bad/mismatched stored token → clear so stale creds don't linger.
            if (response.status === 401 || response.status === 403) {
                await this.clearCredentials();
            }
            throw new Error(`Bitbucket API ${response.status}: ${err}`);
        }

        return response.json() as T;
    }

    // ── Pull Requests ────────────────────────────────────────────────────────

    /** Get state of PR from sourceBranch → destinationBranch */
    async getPRState(
        sourceBranch:      string,
        destinationBranch: string
    ): Promise<"open" | "merged" | "none" | "pipeline_running"> {
        if (!this.workspace || !this.repoSlug) { return "none"; }

        try {
            const result = await this.fetch<any>(
                "GET",
                `/repositories/${this.workspace}/${this.repoSlug}/pullrequests?` +
                `q=source.branch.name="${sourceBranch}"+AND+destination.branch.name="${destinationBranch}"&state=OPEN,MERGED`
            );

            const prs = result.values ?? [];
            if (prs.length === 0) { return "none"; }

            const latest = prs[0];
            if (latest.state === "MERGED") { return "merged"; }
            if (latest.state === "OPEN")   { return "open"; }
        } catch {
            return "none";
        }

        return "none";
    }

    // ── Pipelines ────────────────────────────────────────────────────────────

    /** Get latest pipeline runs */
    async getLatestPipelines(limit = 10): Promise<PipelineRun[]> {
        const result = await this.fetch<any>(
            "GET",
            `/repositories/${this.workspace}/${this.repoSlug}/pipelines/?sort=-created_on&pagelen=${limit}`
        );

        return (result.values ?? []).map((p: any): PipelineRun => ({
            id:        p.build_number,
            state:     p.state?.name ?? "UNKNOWN",
            result:    p.state?.result?.name ?? "",
            succeeded: p.state?.result?.name === "SUCCESSFUL",
            branch:    p.target?.ref_name ?? "",
            commit:    p.target?.commit?.hash?.slice(0, 8) ?? "",
            url:       `${BB_WEB}/${this.workspace}/${this.repoSlug}/pipelines/results/${p.build_number}`,
            createdOn: p.created_on,
        }));
    }

    /** Creates a real PR via the Bitbucket API (used by the 2GP Packaging Release Gate). */
    async createPullRequest(
        sourceBranch:      string,
        destinationBranch: string,
        title:             string,
        body:              string,
        repoOverride?:     { workspace: string; repoSlug: string }
    ): Promise<{ url: string } | null> {
        const workspace = repoOverride?.workspace || this.workspace;
        const repoSlug  = repoOverride?.repoSlug  || this.repoSlug;
        if (!workspace || !repoSlug) { return null; }

        const auth = await this.getOrPromptAuthHeader();
        if (!auth) { return null; }

        try {
            const result = await fetch(`${BB_API}/repositories/${workspace}/${repoSlug}/pullrequests`, {
                method: "POST",
                headers: { "Authorization": auth, "Content-Type": "application/json" },
                body: JSON.stringify({
                    title,
                    description: body,
                    source:      { branch: { name: sourceBranch } },
                    destination: { branch: { name: destinationBranch } },
                }),
            });
            if (!result.ok) {
                if (result.status === 401 || result.status === 403) { await this.clearCredentials(); }
                throw new Error(`Bitbucket API ${result.status}: ${await result.text()}`);
            }
            const pr = await result.json() as any;
            return { url: pr.links?.html?.href || `${BB_WEB}/${workspace}/${repoSlug}/pull-requests/${pr.id}` };
        } catch (err) {
            vscode.window.showWarningMessage(`Could not create the Bitbucket PR automatically: ${err}`);
            return null;
        }
    }

    // ── Repository info ──────────────────────────────────────────────────────

    /** Get list of team members for PR reviewer suggestions */
    async getTeamMembers(): Promise<Array<{ uuid: string; name: string }>> {
        try {
            const result = await this.fetch<any>(
                "GET",
                `/repositories/${this.workspace}/${this.repoSlug}/permissions-config/users?pagelen=50`
            );
            return (result.values ?? []).map((v: any) => ({
                uuid: v.user?.uuid ?? "",
                name: v.user?.display_name ?? "",
            }));
        } catch {
            return [];
        }
    }
}
