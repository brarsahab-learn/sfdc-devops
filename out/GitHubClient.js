"use strict";
// GitHubClient.ts
// GitHub implementation of IGitProviderClient — same status-reads-are-silent,
// PR-creation-prompts-once philosophy as BitbucketClient.ts.
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
exports.GitHubClient = void 0;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
const GH_API = "https://api.github.com";
const GH_WEB = "https://github.com";
class GitHubClient {
    constructor(_context) {
        this._context = _context;
        this.providerName = "github";
    }
    get owner() {
        return (0, config_1.getRepoWorkspace)();
    }
    get repo() {
        return (0, config_1.getRepoSlug)();
    }
    /** Stored token, or null — never prompts. Used by the silent status reads below. */
    async getToken() {
        return (await this._context.secrets.get("sfDevops.ghToken")) || null;
    }
    /** Like getToken(), but prompts for a Personal Access Token (once, then stored) if none exists. */
    async getOrPromptToken() {
        const existing = await this.getToken();
        if (existing) {
            return existing;
        }
        const token = await vscode.window.showInputBox({
            prompt: "GitHub Personal Access Token (needs the \"repo\" scope) — used to create the 2GP beta pull request",
            password: true,
            ignoreFocusOut: true,
        });
        if (!token) {
            return null;
        }
        await this._context.secrets.store("sfDevops.ghToken", token);
        return token;
    }
    async clearToken() {
        await this._context.secrets.delete("sfDevops.ghToken");
    }
    async fetch(method, path, token, body) {
        const headers = { "Accept": "application/vnd.github+json" };
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        const response = await fetch(`${GH_API}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
            const err = await response.text();
            if (token && (response.status === 401 || response.status === 403)) {
                await this.clearToken();
            }
            throw new Error(`GitHub API ${response.status}: ${err}`);
        }
        return response.json();
    }
    /** Builds the "Open a pull request" compare URL, prefilled — used as a fallback when no token is available. */
    buildPrUrl(sourceBranch, destinationBranch, repoOverride, body) {
        const owner = repoOverride?.workspace || this.owner;
        const repo = repoOverride?.repoSlug || this.repo;
        if (!owner || !repo) {
            return "";
        }
        let url = `${GH_WEB}/${owner}/${repo}/compare/${encodeURIComponent(destinationBranch)}...${encodeURIComponent(sourceBranch)}?expand=1`;
        if (body) {
            url += `&body=${encodeURIComponent(body)}`;
        }
        return url;
    }
    /** Parses `https://github.com/owner/repo(.git)` or `git@github.com:owner/repo(.git)`. */
    parseRemoteUrl(remoteUrl) {
        const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
        return m ? { workspace: m[1], repoSlug: m[2] } : null;
    }
    /** Builds the "view this branch" URL for the browser. */
    buildBranchUrl(branch, repoOverride) {
        const owner = repoOverride?.workspace || this.owner;
        const repo = repoOverride?.repoSlug || this.repo;
        if (!owner || !repo) {
            return "";
        }
        return `${GH_WEB}/${owner}/${repo}/tree/${encodeURIComponent(branch)}`;
    }
    async getPRState(sourceBranch, destinationBranch) {
        if (!this.owner || !this.repo) {
            return "none";
        }
        try {
            const token = await this.getToken();
            const prs = await this.fetch("GET", `/repos/${this.owner}/${this.repo}/pulls?head=${this.owner}:${sourceBranch}&base=${destinationBranch}&state=all`, token);
            if (!prs.length) {
                return "none";
            }
            const latest = prs[0];
            if (latest.merged_at) {
                return "merged";
            }
            if (latest.state === "open") {
                return "open";
            }
        }
        catch {
            return "none";
        }
        return "none";
    }
    /** Silent, same as getPRState — never prompts for a token. */
    async getOpenPRUrl(sourceBranch, destinationBranch, repoOverride) {
        const owner = repoOverride?.workspace || this.owner;
        const repo = repoOverride?.repoSlug || this.repo;
        if (!owner || !repo) {
            return null;
        }
        try {
            const token = await this.getToken();
            const prs = await this.fetch("GET", `/repos/${owner}/${repo}/pulls?head=${owner}:${sourceBranch}&base=${destinationBranch}&state=open`, token);
            return prs[0]?.html_url ?? null;
        }
        catch {
            return null;
        }
    }
    async getLatestPipelines(limit = 10) {
        if (!this.owner || !this.repo) {
            return [];
        }
        try {
            const token = await this.getToken();
            const result = await this.fetch("GET", `/repos/${this.owner}/${this.repo}/actions/runs?per_page=${limit}`, token);
            return (result.workflow_runs ?? []).map((r) => ({
                id: r.run_number,
                state: r.status ?? "unknown",
                result: r.conclusion ?? "",
                succeeded: r.conclusion === "success",
                branch: r.head_branch ?? "",
                commit: (r.head_sha ?? "").slice(0, 8),
                url: r.html_url ?? `${GH_WEB}/${this.owner}/${this.repo}/actions`,
                createdOn: r.created_at,
            }));
        }
        catch {
            return [];
        }
    }
    /** Creates a real PR via the GitHub API (used by the 2GP Packaging Release Gate). */
    async createPullRequest(sourceBranch, destinationBranch, title, body, repoOverride) {
        const owner = repoOverride?.workspace || this.owner;
        const repo = repoOverride?.repoSlug || this.repo;
        if (!owner || !repo) {
            return null;
        }
        const token = await this.getOrPromptToken();
        if (!token) {
            return null;
        }
        try {
            const pr = await this.fetch("POST", `/repos/${owner}/${repo}/pulls`, token, { title, body, head: sourceBranch, base: destinationBranch });
            return { url: pr.html_url };
        }
        catch (err) {
            vscode.window.showWarningMessage(`Could not create the GitHub PR automatically: ${err}`);
            return null;
        }
    }
}
exports.GitHubClient = GitHubClient;
//# sourceMappingURL=GitHubClient.js.map