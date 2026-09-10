"use strict";
// GitProviderClient.ts
// Provider-agnostic seam for the Git host (Bitbucket, GitHub, GitLab, Azure DevOps, ...).
// Only Bitbucket is implemented today, but every command talks to this interface —
// not to BitbucketClient directly — so adding a provider is additive, not a rewrite.
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
exports.createGitProviderClient = createGitProviderClient;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
const BitbucketClient_1 = require("./BitbucketClient");
const GitHubClient_1 = require("./GitHubClient");
const registry = {
    bitbucket: BitbucketClient_1.BitbucketClient,
    github: GitHubClient_1.GitHubClient,
};
/** Guesses the provider from the `origin` remote URL's host — used only when sfDevops.gitProvider is unset. */
function detectProviderFromRemote(remoteUrl) {
    if (!remoteUrl) {
        return undefined;
    }
    if (/github\.com/i.test(remoteUrl)) {
        return "github";
    }
    if (/bitbucket\.org/i.test(remoteUrl)) {
        return "bitbucket";
    }
    return undefined;
}
/**
 * Instantiates the client for sfDevops.gitProvider. An explicit setting always wins; when
 * it's left unset, `remoteUrl` (the repo's `origin` remote, if known) picks the provider
 * instead of silently assuming Bitbucket — so a GitHub-origin repo with no gitProvider set
 * still resolves PR/pipeline status correctly. Unknown/unimplemented explicit values fall
 * back to Bitbucket with a one-time warning rather than crashing the extension.
 */
function createGitProviderClient(context, remoteUrl) {
    const explicit = (0, config_1.getGitProviderRaw)();
    const provider = explicit || detectProviderFromRemote(remoteUrl) || "bitbucket";
    const ClientClass = registry[provider];
    if (!ClientClass) {
        vscode.window.showWarningMessage(`sfDevops.gitProvider is set to "${provider}", which isn't implemented yet. ` +
            `Falling back to Bitbucket. Supported providers: ${Object.keys(registry).join(", ")}.`);
        return new BitbucketClient_1.BitbucketClient(context);
    }
    return new ClientClass(context);
}
//# sourceMappingURL=GitProviderClient.js.map