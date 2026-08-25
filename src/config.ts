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
 * Regex used to recognize a story/ticket key inside a branch name (e.g. to pull
 * "IB-123" back out of a feature branch). Not used to validate story ID input —
 * that accepts free text. Falls back to deriving one from the (legacy)
 * jiraProjectKey setting, then to a generic Jira-shaped key, so existing configs
 * keep working.
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

/**
 * Extracts the story/ticket id from a branch name using the configured pattern.
 * Matches only against the part after the feature-branch prefix (e.g. "feature/") so a
 * broad ticketKeyPattern can never capture the prefix itself and get fed back into
 * featureBranchName(), which would double it up (e.g. "feature/feature/...").
 */
export function extractStoryId(branch: string | null | undefined): string {
    if (!branch) { return ""; }
    const prefix   = getFeatureBranchPrefix();
    const withoutPrefix = prefix.length > 0 && branch.startsWith(prefix) ? branch.slice(prefix.length) : branch;
    const match = withoutPrefix.match(getTicketKeyPattern());
    return match ? match[0] : "";
}

/**
 * Turns free-text story ID input into a valid git ref segment (a story ID can now be
 * any text, not just a "PROJECT-123"-shaped key — see getTicketKeyPattern above).
 * Collapses whitespace/punctuation runs to a single "-" and strips characters
 * `git check-ref-format` rejects, so `featureBranchName()` always produces a valid branch.
 */
export function sanitizeStoryId(input: string): string {
    return input
        .trim()
        .replace(/[\s~^:?*[\]\\]+/g, "-")   // git-forbidden / whitespace → "-"
        .replace(/[^A-Za-z0-9._-]+/g, "-")  // anything else non-ref-safe → "-"
        .replace(/\.{2,}/g, "-")            // ".." is forbidden in refs
        .replace(/-{2,}/g, "-")
        .replace(/^[-.\/]+|[-.\/]+$/g, ""); // no leading/trailing "-", ".", "/"
}

// ── Roles ────────────────────────────────────────────────────────────────────

export function getRoles(): string[] {
    return cfg().get<string[]>("roles") || ["Developer", "Lead", "Admin"];
}

/**
 * @deprecated Legacy fallback only — real role resolution goes through
 * RoleManager.getEffectiveRole(context), which is password-gated for Lead/Admin and
 * stored outside this freely-editable setting. This getter stays as the bootstrap
 * default for a fresh install (before anyone has ever changed role via that flow).
 */
export function getCurrentRole(): string {
    return cfg().get<string>("role") || "Developer";
}

// ── Environments ─────────────────────────────────────────────────────────────

export interface EnvironmentSetting {
    name:         string;
    label?:       string;
    branch?:      string;
    icon?:        string;
    requiredRole?: string;
    coverageGate?: boolean;
    signoffGate?: boolean;
    orgAlias?:    string;
    deployTestLevel?: string;
    /** Explicit override for "is this Prod" — see ResolvedEnvironment.isProd. */
    isProd?:      boolean;
}

export interface ResolvedEnvironment {
    name:         string;
    label:        string;
    branch:       string;
    icon:         string;
    requiredRole?: string;
    coverageGate: boolean;
    /** True if a human sign-off must be recorded on THIS environment before the story can be promoted to whatever comes after it. */
    signoffGate:  boolean;
    orgAlias?:    string;
    deployTestLevel: string;
    /**
     * True for the environment safety-critical gates (like auto-deploy-after-validate)
     * must never bypass. Defaults to `name === "prod"` for backward compatibility, but can
     * be set explicitly via sfDevops.environments[].isProd — e.g. if a team renames their
     * production environment, the implicit name-based default would otherwise silently
     * stop protecting it.
     */
    isProd:       boolean;
}

const DEFAULT_ENVIRONMENTS: EnvironmentSetting[] = [
    { name: "dev" },
    { name: "qa",   coverageGate: true },
    { name: "uat",  requiredRole: "Lead" },
    // Prod's branch is deliberately the same as sfDevops.baseBranch ("main") — a
    // trunk-based model where feature branches cut from main and promotion eventually
    // merges back into it. Admin-only: Lead can do everything except this last step.
    { name: "prod", branch: "main", requiredRole: "Admin" },
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

    return list
        .filter((entry): entry is EnvironmentSetting | string => {
            // A malformed sfDevops.environments entry (null, {}, missing "name") would
            // otherwise throw deep inside every panel's refresh() with an unhelpful
            // "Cannot read properties of undefined" — skip it with a clear warning instead.
            const name = typeof entry === "string" ? entry : entry?.name;
            if (!name) {
                vscode.window.showWarningMessage(
                    `Ignoring an sfDevops.environments entry with no "name" — check your settings.`
                );
                return false;
            }
            return true;
        })
        .map((entry): ResolvedEnvironment => {
            const e: EnvironmentSetting = typeof entry === "string" ? { name: entry } : entry;
            return {
                name:         e.name,
                label:        e.label || e.name.toUpperCase(),
                branch:       e.branch || e.name,
                icon:         e.icon || "circle-outline",
                requiredRole: e.requiredRole,
                coverageGate: e.coverageGate ?? false,
                signoffGate:  e.signoffGate ?? false,
                orgAlias:     e.orgAlias,
                deployTestLevel: e.deployTestLevel || "RunRelevantTests",
                isProd:       e.isProd ?? (e.name === "prod"),
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

/**
 * Where the coverage check should actually run tests: the org the story's changes are
 * CURRENTLY sitting in — i.e. the environment immediately before the coverage-gated one
 * in the pipeline — not always a hardcoded "dev". If the gate sits right after the
 * publish stage (the common case), that's sfDevops.devOrgAlias (the canonical setting
 * for that stage); if the gate is further down the pipeline (e.g. on uat after a qa
 * stage), it's that prior environment's own orgAlias.
 */
export function getCoverageSourceOrg(): { alias: string; label: string } {
    const devAlias = getDevOrgAlias();
    const gateEnv  = getCoverageGateEnvironment();
    if (!gateEnv) { return { alias: devAlias, label: "Dev" }; }

    const envs = getEnvironments();
    const idx  = envs.findIndex(e => e.name === gateEnv.name);
    const prev = idx > 0 ? envs[idx - 1] : undefined;
    if (!prev || idx === 1) {
        // Gate sits right after the publish/dev stage — devOrgAlias is that stage's setting.
        return { alias: devAlias || prev?.orgAlias || "", label: "Dev" };
    }
    return { alias: prev.orgAlias || devAlias || "", label: prev.label };
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

/** The raw sfDevops.gitProvider setting, or undefined if left unset — lets callers tell "unset" apart from "explicitly bitbucket" (getGitProvider() can't, since it applies the default itself). */
export function getGitProviderRaw(): string | undefined {
    return cfg().get<string>("gitProvider") || undefined;
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

/** Reference/informational only — prod is deployed by a separate DevOps team, not this extension. */
export function getProdOrgAlias(): string {
    return cfg().get<string>("prodOrgAlias") || "";
}

// ── Org alias management (dev / qa / uat / prod) ─────────────────────────────
// A fixed, canonical set of 4 slots — matches this extension's default pipeline
// shape (DEFAULT_ENVIRONMENTS below) plus the reference-only prod setting. Used by
// the Setup Check panel to let a user view/edit/authenticate each one directly,
// without hand-editing settings.json.

export type OrgAliasSlotKey = "dev" | "qa" | "uat" | "prod";

export interface OrgAliasSlot {
    key:   OrgAliasSlotKey;
    label: string;
    alias: string;
}

export function getOrgAliasSlots(): OrgAliasSlot[] {
    const qa  = findEnvironment("qa");
    const uat = findEnvironment("uat");
    const prodEnv = findEnvironment("prod");

    return [
        { key: "dev",  label: "Dev",              alias: getDevOrgAlias() },
        { key: "qa",   label: qa?.label  ?? "QA",  alias: qa?.orgAlias  ?? "" },
        { key: "uat",  label: uat?.label ?? "UAT", alias: uat?.orgAlias ?? "" },
        // prodEnv only exists if a team has deliberately opted "prod" into the real
        // promotion pipeline (sfDevops.environments) — otherwise this stays the
        // reference-only prodOrgAlias setting, same as everywhere else in the extension.
        { key: "prod", label: prodEnv?.label ?? "Prod", alias: prodEnv?.orgAlias || getProdOrgAlias() },
    ];
}

/** Materializes the resolved environments array (defaults included) into an explicit setting, so a single-field edit doesn't wipe out the rest. */
async function updateEnvironmentOrgAlias(envName: string, alias: string): Promise<void> {
    const raw = cfg().get<Array<EnvironmentSetting | string>>("environments");
    const base: EnvironmentSetting[] = (raw && raw.length > 0)
        ? raw.map(e => (typeof e === "string" ? { name: e } : { ...e }))
        : DEFAULT_ENVIRONMENTS.map(e => ({ ...e }));

    const existing = base.find(e => e.name === envName);
    if (existing) { existing.orgAlias = alias; } else { base.push({ name: envName, orgAlias: alias }); }

    await cfg().update("environments", base, vscode.ConfigurationTarget.Workspace);
}

/**
 * Saves an org alias for one of the 4 canonical slots. "prod" is deliberately never
 * added to sfDevops.environments here — that would silently turn Prod into a real,
 * everyone-visible promotion stage. It only updates the reference-only prodOrgAlias
 * setting, syncing environments[].orgAlias too if (and only if) a "prod" entry has
 * already been deliberately added there.
 */
export async function setOrgAliasSlot(key: OrgAliasSlotKey, alias: string): Promise<void> {
    if (key === "dev") {
        await cfg().update("devOrgAlias", alias, vscode.ConfigurationTarget.Workspace);
        return;
    }
    if (key === "prod") {
        await cfg().update("prodOrgAlias", alias, vscode.ConfigurationTarget.Workspace);
        if (getEnvironments().some(e => e.name === "prod")) { await updateEnvironmentOrgAlias("prod", alias); }
        return;
    }
    await updateEnvironmentOrgAlias(key, alias);
}

export function getSourceRootFolder(): string {
    return cfg().get<string>("sourceRootFolder") || "force-app";
}

/** Timeout for a `sf project deploy start|validate` run, in seconds. */
export function getDeployTimeoutSeconds(): number {
    return cfg().get<number>("deployTimeoutSeconds") ?? 900;
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
