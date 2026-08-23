// config.ts
// Single source of truth for every sfDevops.* setting. Nothing in the rest of the
// extension should read vscode.workspace.getConfiguration("sfDevops") directly for
// anything covered here — that's what caused the original branch-naming / role /
// environment logic to drift across files. Add new org-configurable behavior here.

import * as vscode from "vscode";

// ── Raw config access ────────────────────────────────────────────────────────

function cfg() {
    return vscode.workspace.getConfiguration("sfDevops");
}

// ── Branch naming ────────────────────────────────────────────────────────────

export function getBaseBranch(): string {
    return cfg().get<string>("baseBranch") || "main";
}

/**
 * The branch the first configured environment publishes to (legacy "dev"). Prefers the
 * first entry of sfDevops.environments; falls back to the deprecated sfDevops.devBranch
 * setting, then to "dev", for 1.x settings.json files.
 */
export function getDevBranch(): string {
    const envs = getEnvironments();
    if (envs.length > 0) { return envs[0].branch; }
    return cfg().get<string>("devBranch") || "dev";
}

export function getFeatureBranchTemplate(): string {
    return cfg().get<string>("featureBranchTemplate") || "feature/{storyId}";
}

export function getPromotionBranchTemplate(): string {
    return cfg().get<string>("promotionBranchTemplate") || "promotion/{storyId}-to-{env}";
}

export function getValidateBranchTemplate(): string {
    return cfg().get<string>("validateBranchTemplate") || "validate/{storyId}-to-{env}";
}

function fillTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_match, key) => vars[key] ?? "");
}

/** Builds the feature branch name for a story, e.g. "feature/PROJ-123". */
export function featureBranchName(storyId: string): string {
    return fillTemplate(getFeatureBranchTemplate(), { storyId });
}

/** The literal prefix before the first `{placeholder}` in the feature branch template. */
export function getFeatureBranchPrefix(): string {
    return getFeatureBranchTemplate().split("{")[0];
}

/** True if the given branch name looks like a feature branch under the configured template. */
export function isFeatureBranch(branch: string | null | undefined): boolean {
    if (!branch) { return false; }
    const prefix = getFeatureBranchPrefix();
    return prefix.length > 0 ? branch.startsWith(prefix) : false;
}

/** Builds a promotion or validate branch name for a story + target environment. */
export function promoBranchName(storyId: string, env: string, mode: "validate" | "promote"): string {
    const template = mode === "validate" ? getValidateBranchTemplate() : getPromotionBranchTemplate();
    return fillTemplate(template, { storyId, env });
}

// ── Ticketing / story ID ─────────────────────────────────────────────────────

/**
 * Regex used to recognize a story/ticket key inside a branch name.
 * Falls back to deriving one from the (legacy) jiraProjectKey setting, then to a
 * generic Jira-shaped key, so existing configs keep working.
 */
export function getTicketKeyPattern(): RegExp {
    const explicit = cfg().get<string>("ticketKeyPattern");
    if (explicit) {
        try { return new RegExp(explicit); } catch { /* fall through to default */ }
    }
    const projectKey = cfg().get<string>("jiraProjectKey");
    if (projectKey) {
        try { return new RegExp(`${projectKey}-\\d+`); } catch { /* fall through */ }
    }
    return /[A-Za-z][A-Za-z0-9]*-\d+/;
}

export function getTicketSystem(): string {
    return cfg().get<string>("ticketSystem") || "jira";
}

export function getTicketBaseUrl(): string {
    return cfg().get<string>("ticketBaseUrl") || "";
}

/** Builds a link to the ticket in the configured ticketing system, if a base URL is set. */
export function buildTicketUrl(storyId: string): string | undefined {
    const base = getTicketBaseUrl();
    if (!base || !storyId) { return undefined; }
    return fillTemplate(base, { storyId });
}

/** Extracts the story/ticket id from a branch name using the configured pattern. */
export function extractStoryId(branch: string | null | undefined): string {
    if (!branch) { return ""; }
    const match = branch.match(getTicketKeyPattern());
    return match ? match[0] : "";
}

// ── Roles ────────────────────────────────────────────────────────────────────

export function getRoles(): string[] {
    return cfg().get<string[]>("roles") || ["developer", "TrackLead"];
}

export function getCurrentRole(): string {
    return cfg().get<string>("role") || "developer";
}

// ── Environments ─────────────────────────────────────────────────────────────

export interface EnvironmentSetting {
    name:         string;
    label?:       string;
    branch?:      string;
    icon?:        string;
    requiredRole?: string;
    coverageGate?: boolean;
    orgAlias?:    string;
}

export interface ResolvedEnvironment {
    name:         string;
    label:        string;
    branch:       string;
    icon:         string;
    requiredRole?: string;
    coverageGate: boolean;
    orgAlias?:    string;
}

const DEFAULT_ENVIRONMENTS: EnvironmentSetting[] = [
    { name: "dev" },
    { name: "qa",  coverageGate: true },
    { name: "uat", requiredRole: "TrackLead" },
];

/**
 * The full configured pipeline, in order. The first environment is always treated as
 * the "publish straight from the feature branch" stage (legacy "dev"); every
 * environment after it is promoted/validated via a promotion branch + PR.
 * Accepts either the new object-array shape or a legacy flat string array
 * (e.g. ["dev", "qa", "uat"]) so old settings.json files keep working.
 */
export function getEnvironments(): ResolvedEnvironment[] {
    const raw = cfg().get<Array<EnvironmentSetting | string>>("environments");
    const list = (raw && raw.length > 0) ? raw : DEFAULT_ENVIRONMENTS;

    return list.map((entry): ResolvedEnvironment => {
        const e: EnvironmentSetting = typeof entry === "string" ? { name: entry } : entry;
        return {
            name:         e.name,
            label:        e.label || e.name.toUpperCase(),
            branch:       e.branch || e.name,
            icon:         e.icon || "circle-outline",
            requiredRole: e.requiredRole,
            coverageGate: e.coverageGate ?? false,
            orgAlias:     e.orgAlias,
        };
    });
}

/** The first configured environment — published directly from the feature branch, no PR. */
export function getPublishEnvironment(): ResolvedEnvironment {
    return getEnvironments()[0];
}

/** Every environment after the first one — reached via promotion/validate branch + PR. */
export function getPromotableEnvironments(): ResolvedEnvironment[] {
    return getEnvironments().slice(1);
}

export function findEnvironment(name: string): ResolvedEnvironment | undefined {
    return getEnvironments().find(e => e.name === name);
}

/** The environment (if any) whose coverageGate is set — used to gate the Apex coverage check. */
export function getCoverageGateEnvironment(): ResolvedEnvironment | undefined {
    return getPromotableEnvironments().find(e => e.coverageGate);
}

/** True if `role` is allowed to run Promote & Deploy into `env` (Validate Only is always allowed). */
export function canPromote(role: string, env: ResolvedEnvironment): boolean {
    return !env.requiredRole || role === env.requiredRole;
}

/** Message shown once a story has been merged into the last configured environment. */
export function getTerminalStageMessage(): string {
    const envs = getEnvironments();
    const last = envs[envs.length - 1];
    const template = cfg().get<string>("terminalStageMessage")
        || "Story deployed up to {lastEnvLabel}. Anything beyond this stage is handled outside this extension.";
    return fillTemplate(template, { lastEnvLabel: last?.label ?? "" });
}

// ── Git provider / repo identity ─────────────────────────────────────────────

export function getGitProvider(): string {
    return cfg().get<string>("gitProvider") || "bitbucket";
}

/** Provider-neutral repo identity, falling back to the legacy Bitbucket-specific setting names. */
export function getRepoWorkspace(): string {
    return cfg().get<string>("repoWorkspace") || cfg().get<string>("bitbucketWorkspace") || "";
}

export function getRepoSlug(): string {
    return cfg().get<string>("repoSlug") || cfg().get<string>("bitbucketRepoSlug") || "";
}

// ── Coverage / source layout ─────────────────────────────────────────────────

export function getCoverageThreshold(): number {
    return cfg().get<number>("coverageThreshold") ?? 75;
}

export function getCoverageTimeoutSeconds(): number {
    return cfg().get<number>("coverageTimeoutSeconds") ?? 600;
}

export function getDevOrgAlias(): string {
    return cfg().get<string>("devOrgAlias") || "";
}

export function getSourceRootFolder(): string {
    return cfg().get<string>("sourceRootFolder") || "force-app";
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function getStaleBranchThreshold(): number {
    return cfg().get<number>("staleBranchThreshold") ?? 5;
}

// ── 2GP Packaging Release Gate (Dedicated 2GP Release Gate, triggered from the UAT
// branch) ─────────────────────────────────────────────────────────────────────
// A second, occasional track distinct from the day-to-day sprint flow above: it doesn't
// touch sfDevops.environments/baseBranch at all, it compares UAT against a separate
// packaging baseline branch and produces a 2GP beta PR. Everything it needs is under
// sfDevops.packaging so it stays fully settings-driven, same as the rest of this file.

export function getPackageBaselineBranch(): string {
    return cfg().get<string>("packageBaselineBranch") || "2gp-main";
}

/** Branch the 2GP gate reads its "what changed" diff from — defaults to the UAT environment's branch. */
export function getPackagingSourceBranch(): string {
    const explicit = cfg().get<string>("packagingSourceBranch");
    if (explicit) { return explicit; }
    const uat = findEnvironment("uat");
    return uat?.branch || "uat";
}

/** Role (from sfDevops.roles) required to run "Prepare 2GP Beta from UAT". Empty = unrestricted. */
export function getPackagingRequiredRole(): string {
    return cfg().get<string>("packagingRequiredRole") || "";
}

export interface PackagingSettings {
    packageName:      string;
    sourceBase:       string;
    managedTarget:    string;
    unmanagedTarget:  string;
    docsDirectory:    string;
    patchOverrides:   string[];
    excludedMetadata: string[];
    devHubOrgAlias:   string;
}

const DEFAULT_PACKAGING: PackagingSettings = {
    packageName:      "",
    sourceBase:       "force-app/main/default",
    managedTarget:    "force-app/managed/main/default",
    unmanagedTarget:  "force-app/unmanaged/main/default",
    docsDirectory:    "docs/releases",
    patchOverrides:   [],
    excludedMetadata: ["**/profiles/**", "**/settings/**"],
    devHubOrgAlias:   "",
};

/** Everything the 2GP Release Gate needs — a single settings object, sfDevops.packaging. */
export function getPackagingSettings(): PackagingSettings {
    const raw = cfg().get<Partial<PackagingSettings>>("packaging") || {};
    return {
        packageName:      raw.packageName ?? DEFAULT_PACKAGING.packageName,
        sourceBase:       raw.sourceBase ?? DEFAULT_PACKAGING.sourceBase,
        managedTarget:    raw.managedTarget ?? DEFAULT_PACKAGING.managedTarget,
        unmanagedTarget:  raw.unmanagedTarget ?? DEFAULT_PACKAGING.unmanagedTarget,
        docsDirectory:    raw.docsDirectory ?? DEFAULT_PACKAGING.docsDirectory,
        patchOverrides:   raw.patchOverrides ?? DEFAULT_PACKAGING.patchOverrides,
        excludedMetadata: raw.excludedMetadata ?? DEFAULT_PACKAGING.excludedMetadata,
        devHubOrgAlias:   raw.devHubOrgAlias ?? DEFAULT_PACKAGING.devHubOrgAlias,
    };
}
