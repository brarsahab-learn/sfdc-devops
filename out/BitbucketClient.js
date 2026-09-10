"use strict";
// BitbucketClient.ts
// Handles all Bitbucket REST API calls.
// Status reads are silent; credentials are only prompted when creating a PR.
// Supports Bitbucket's current auth: Repository/Workspace Access Token (Bearer)
// or Atlassian API token (Basic with your Atlassian email). App passwords are deprecated.
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
exports.BitbucketClient = void 0;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
const BB_API = "https://api.bitbucket.org/2.0";
const BB_WEB = "https://bitbucket.org";
class BitbucketClient {
    constructor(_context) {
        this._context = _context;
        this.providerName = "bitbucket";
    }
    // ── Auth ──────────────────────────────────────────────────────────────────
    // Status reads only, and always silent — never prompts.
    // PR creation happens in the browser, so the extension needs no token/app password.
    async getAuthHeader() {
        if (this._authHeader) {
            return this._authHeader;
        }
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
    async clearCredentials() {
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
    async getOrPromptAuthHeader() {
        try {
            return await this.getAuthHeader();
        }
        catch {
            const token = await vscode.window.showInputBox({
                prompt: "Bitbucket Repository/Workspace Access Token (or Atlassian API token)",
                password: true,
                ignoreFocusOut: true,
            });
            if (!token) {
                return null;
            }
            const email = await vscode.window.showInputBox({
                prompt: "Atlassian account email (leave empty if using a Bitbucket Access Token)",
                ignoreFocusOut: true,
            });
            await this._context.secrets.store("sfDevops.bbToken", token);
            if (email) {
                await this._context.secrets.store("sfDevops.bbEmail", email);
            }
            this._authHeader = email
                ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
                : `Bearer ${token}`;
            return this._authHeader;
        }
    }
    get workspace() {
        return (0, config_1.getRepoWorkspace)();
    }
    get repoSlug() {
        return (0, config_1.getRepoSlug)();
    }
    /** Builds the "create pull request" URL for source -> destination, opened in the browser. */
    buildPrUrl(sourceBranch, destinationBranch, repoOverride, body) {
        const workspace = repoOverride?.workspace || this.workspace;
        const repoSlug = repoOverride?.repoSlug || this.repoSlug;
        if (!workspace || !repoSlug) {
            return "";
        }
        let url = `${BB_WEB}/${workspace}/${repoSlug}/pull-requests/new` +
            `?source=${encodeURIComponent(sourceBranch)}` +
            `&dest=${encodeURIComponent(destinationBranch)}`;
        if (body) {
            url += `&description=${encodeURIComponent(body)}`;
        }
        return url;
    }
    /** Parses `https://bitbucket.org/ws/repo(.git)` or `git@bitbucket.org:ws/repo(.git)`. */
    parseRemoteUrl(remoteUrl) {
        const m = remoteUrl.match(/bitbucket\.org[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
        return m ? { workspace: m[1], repoSlug: m[2] } : null;
    }
    /** Builds the "view this branch" URL for the browser. */
    buildBranchUrl(branch, repoOverride) {
        const workspace = repoOverride?.workspace || this.workspace;
        const repoSlug = repoOverride?.repoSlug || this.repoSlug;
        if (!workspace || !repoSlug) {
            return "";
        }
        return `${BB_WEB}/${workspace}/${repoSlug}/branch/${encodeURIComponent(branch)}`;
    }
    async fetch(method, path, body) {
        const auth = await this.getAuthHeader();
        const url = `${BB_API}${path}`;
        const headers = {
            "Authorization": auth,
            "Content-Type": "application/json",
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
        return response.json();
    }
    // ── Pull Requests ────────────────────────────────────────────────────────
    /** Get state of PR from sourceBranch → destinationBranch */
    async getPRState(sourceBranch, destinationBranch) {
        if (!this.workspace || !this.repoSlug) {
            return "none";
        }
        try {
            const result = await this.fetch("GET", `/repositories/${this.workspace}/${this.repoSlug}/pullrequests?` +
                `q=source.branch.name="${sourceBranch}"+AND+destination.branch.name="${destinationBranch}"&state=OPEN,MERGED`);
            const prs = result.values ?? [];
            if (prs.length === 0) {
                return "none";
            }
            const latest = prs[0];
            if (latest.state === "MERGED") {
                return "merged";
            }
            if (latest.state === "OPEN") {
                return "open";
            }
        }
        catch {
            return "none";
        }
        return "none";
    }
    /** Silent, same as getPRState — never prompts for credentials. */
    async getOpenPRUrl(sourceBranch, destinationBranch, repoOverride) {
        const workspace = repoOverride?.workspace || this.workspace;
        const repoSlug = repoOverride?.repoSlug || this.repoSlug;
        if (!workspace || !repoSlug) {
            return null;
        }
        try {
            const result = await this.fetch("GET", `/repositories/${workspace}/${repoSlug}/pullrequests?` +
                `q=source.branch.name="${sourceBranch}"+AND+destination.branch.name="${destinationBranch}"&state=OPEN`);
            const pr = (result.values ?? [])[0];
            return pr ? (pr.links?.html?.href || `${BB_WEB}/${workspace}/${repoSlug}/pull-requests/${pr.id}`) : null;
        }
        catch {
            return null;
        }
    }
    // ── Pipelines ────────────────────────────────────────────────────────────
    /** Get latest pipeline runs */
    async getLatestPipelines(limit = 10) {
        const result = await this.fetch("GET", `/repositories/${this.workspace}/${this.repoSlug}/pipelines/?sort=-created_on&pagelen=${limit}`);
        return (result.values ?? []).map((p) => ({
            id: p.build_number,
            state: p.state?.name ?? "UNKNOWN",
            result: p.state?.result?.name ?? "",
            succeeded: p.state?.result?.name === "SUCCESSFUL",
            branch: p.target?.ref_name ?? "",
            commit: p.target?.commit?.hash?.slice(0, 8) ?? "",
            url: `${BB_WEB}/${this.workspace}/${this.repoSlug}/pipelines/results/${p.build_number}`,
            createdOn: p.created_on,
        }));
    }
    /** Creates a real PR via the Bitbucket API (used by the 2GP Packaging Release Gate). */
    async createPullRequest(sourceBranch, destinationBranch, title, body, repoOverride) {
        const workspace = repoOverride?.workspace || this.workspace;
        const repoSlug = repoOverride?.repoSlug || this.repoSlug;
        if (!workspace || !repoSlug) {
            return null;
        }
        const auth = await this.getOrPromptAuthHeader();
        if (!auth) {
            return null;
        }
        try {
            const result = await fetch(`${BB_API}/repositories/${workspace}/${repoSlug}/pullrequests`, {
                method: "POST",
                headers: { "Authorization": auth, "Content-Type": "application/json" },
                body: JSON.stringify({
                    title,
                    description: body,
                    source: { branch: { name: sourceBranch } },
                    destination: { branch: { name: destinationBranch } },
                }),
            });
            if (!result.ok) {
                if (result.status === 401 || result.status === 403) {
                    await this.clearCredentials();
                }
                throw new Error(`Bitbucket API ${result.status}: ${await result.text()}`);
            }
            const pr = await result.json();
            return { url: pr.links?.html?.href || `${BB_WEB}/${workspace}/${repoSlug}/pull-requests/${pr.id}` };
        }
        catch (err) {
            vscode.window.showWarningMessage(`Could not create the Bitbucket PR automatically: ${err}`);
            return null;
        }
    }
    // ── Repository info ──────────────────────────────────────────────────────
    /** Get list of team members for PR reviewer suggestions */
    async getTeamMembers() {
        try {
            const result = await this.fetch("GET", `/repositories/${this.workspace}/${this.repoSlug}/permissions-config/users?pagelen=50`);
            return (result.values ?? []).map((v) => ({
                uuid: v.user?.uuid ?? "",
                name: v.user?.display_name ?? "",
            }));
        }
        catch {
            return [];
        }
    }
}
exports.BitbucketClient = BitbucketClient;
//# sourceMappingURL=BitbucketClient.js.map