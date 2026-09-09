"use strict";
// config.ts
// Single source of truth for every sfDevops.* setting. Nothing in the rest of the
// extension should read vscode.workspace.getConfiguration("sfDevops") directly for
// anything covered here — that's what caused the original branch-naming / role /
// environment logic to drift across files. Add new org-configurable behavior here.
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
exports.initOrgAliasStore = initOrgAliasStore;
exports.getBaseBranch = getBaseBranch;
exports.getDevBranch = getDevBranch;
exports.getFeatureBranchTemplate = getFeatureBranchTemplate;
exports.getPromotionBranchTemplate = getPromotionBranchTemplate;
exports.getValidateBranchTemplate = getValidateBranchTemplate;
exports.featureBranchName = featureBranchName;
exports.getFeatureBranchPrefix = getFeatureBranchPrefix;
exports.isFeatureBranch = isFeatureBranch;
exports.promoBranchName = promoBranchName;
exports.getTicketKeyPattern = getTicketKeyPattern;
exports.getTicketSystem = getTicketSystem;
exports.getTicketBaseUrl = getTicketBaseUrl;
exports.buildTicketUrl = buildTicketUrl;
exports.extractStoryId = extractStoryId;
exports.sanitizeStoryId = sanitizeStoryId;
exports.getRoles = getRoles;
exports.isDataLoadRole = isDataLoadRole;
exports.getCurrentRole = getCurrentRole;
exports.getEnvironments = getEnvironments;
exports.saveEnvironments = saveEnvironments;
exports.getPublishEnvironment = getPublishEnvironment;
exports.getPromotableEnvironments = getPromotableEnvironments;
exports.findEnvironment = findEnvironment;
exports.getCoverageGateEnvironment = getCoverageGateEnvironment;
exports.getCoverageSourceOrg = getCoverageSourceOrg;
exports.canPromote = canPromote;
exports.getStaleStoryThresholdDays = getStaleStoryThresholdDays;
exports.getAuditLogRetentionDays = getAuditLogRetentionDays;
exports.getTerminalStageMessage = getTerminalStageMessage;
exports.getGitProvider = getGitProvider;
exports.getGitProviderRaw = getGitProviderRaw;
exports.getRepoWorkspace = getRepoWorkspace;
exports.getRepoSlug = getRepoSlug;
exports.getCoverageThreshold = getCoverageThreshold;
exports.getCoverageTimeoutSeconds = getCoverageTimeoutSeconds;
exports.getDevOrgAlias = getDevOrgAlias;
exports.getProdOrgAlias = getProdOrgAlias;
exports.getDemoOrgAlias = getDemoOrgAlias;
exports.setDemoOrgAlias = setDemoOrgAlias;
exports.getOrgAliasSlots = getOrgAliasSlots;
exports.setOrgAliasSlot = setOrgAliasSlot;
exports.getSourceRootFolder = getSourceRootFolder;
exports.getDeployTimeoutSeconds = getDeployTimeoutSeconds;
exports.isVerboseLogsEnabled = isVerboseLogsEnabled;
exports.getStaleBranchThreshold = getStaleBranchThreshold;
exports.getFallbackRefreshSeconds = getFallbackRefreshSeconds;
exports.getPackageBaselineBranch = getPackageBaselineBranch;
exports.getPackagingSourceBranch = getPackagingSourceBranch;
exports.getPackagingRequiredRole = getPackagingRequiredRole;
exports.getPackagingSettings = getPackagingSettings;
const vscode = __importStar(require("vscode"));
// ── Raw config access ────────────────────────────────────────────────────────
function cfg() {
    return vscode.workspace.getConfiguration("sfDevops");
}
// ── Org aliases (machine-local, NOT stored in settings) ──────────────────────
// Org aliases used to live in sfDevops.environments[].orgAlias / devOrgAlias / prodOrgAlias
// — regular VS Code settings, which for a workspace folder means .vscode/settings.json
// INSIDE the repo. That file is git-tracked, so its content differs per branch — and since
// this extension checks out different branches constantly as part of normal operation
// (promote, validate, deploy all temporarily switch branches), an alias saved while on one
// branch would appear to "vanish" the moment a different branch (whose committed
// settings.json never had it) got checked out. Org aliases are a "which orgs I've
// authenticated on this machine" fact, not something that should vary with git history —
// so they're now stored in globalState instead: machine-local, untouched by branch
// switches, and untouched by reinstalling/updating the extension. Settings values are kept
// as a one-time fallback below so existing configs keep working until the next Save.
let _extContext;
/** Must be called once from activate() before any org-alias function is used. */
function initOrgAliasStore(context) {
    _extContext = context;
}
const ORG_ALIASES_KEY = "sfDevops.orgAliases";
// In-memory guard prevents concurrent calls from racing before the async write lands.
let _orgAliasesMigrationDone = false;
/**
 * Migrate org alias data from globalState to workspaceState on first use,
 * so each workspace/project has independent org alias mappings.
 */
function _migrateOrgAliasesIfNeeded() {
    if (!_extContext) {
        return;
    }
    if (_orgAliasesMigrationDone) {
        return;
    }
    const alreadyMigrated = _extContext.workspaceState.get("sfDevops.orgAliasesMigrated");
    _orgAliasesMigrationDone = true; // set immediately so concurrent calls bail out
    if (alreadyMigrated) {
        return;
    }
    const legacy = _extContext.globalState.get(ORG_ALIASES_KEY);
    if (legacy && Object.keys(legacy).length > 0) {
        const existing = _extContext.workspaceState.get(ORG_ALIASES_KEY) ?? {};
        // Only copy if workspace has no aliases yet (avoid overwriting project-specific data)
        if (Object.keys(existing).length === 0) {
            _extContext.workspaceState.update(ORG_ALIASES_KEY, legacy);
        }
    }
    _extContext.workspaceState.update("sfDevops.orgAliasesMigrated", true);
}
function readOrgAliases() {
    _migrateOrgAliasesIfNeeded();
    return _extContext?.workspaceState.get(ORG_ALIASES_KEY) ?? {};
}
async function writeOrgAlias(key, alias) {
    if (!_extContext) {
        return;
    }
    _migrateOrgAliasesIfNeeded();
    const data = readOrgAliases();
    data[key] = alias;
    await _extContext.workspaceState.update(ORG_ALIASES_KEY, data);
}
// ── Branch naming ────────────────────────────────────────────────────────────
function getBaseBranch() {
    return cfg().get("baseBranch") || "main";
}
/**
 * The branch the first configured environment publishes to (legacy "dev"). Prefers the
 * first entry of sfDevops.environments; falls back to the deprecated sfDevops.devBranch
 * setting, then to "dev", for 1.x settings.json files.
 */
function getDevBranch() {
    const envs = getEnvironments();
    if (envs.length > 0) {
        return envs[0].branch;
    }
    return cfg().get("devBranch") || "dev";
}
function getFeatureBranchTemplate() {
    return cfg().get("featureBranchTemplate") || "feature/{storyId}";
}
function getPromotionBranchTemplate() {
    return cfg().get("promotionBranchTemplate") || "promotion/{storyId}-to-{env}";
}
function getValidateBranchTemplate() {
    return cfg().get("validateBranchTemplate") || "validate/{storyId}-to-{env}";
}
function fillTemplate(template, vars) {
    return template.replace(/\{(\w+)\}/g, (_match, key) => vars[key] ?? "");
}
/** Builds the feature branch name for a story, e.g. "feature/PROJ-123". */
function featureBranchName(storyId) {
    return fillTemplate(getFeatureBranchTemplate(), { storyId });
}
/** The literal prefix before the first `{placeholder}` in the feature branch template. */
function getFeatureBranchPrefix() {
    return getFeatureBranchTemplate().split("{")[0];
}
/** True if the given branch name looks like a feature branch under the configured template. */
function isFeatureBranch(branch) {
    if (!branch) {
        return false;
    }
    const prefix = getFeatureBranchPrefix();
    return prefix.length > 0 ? branch.startsWith(prefix) : false;
}
/** Builds a promotion or validate branch name for a story + target environment. */
function promoBranchName(storyId, env, mode) {
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
function getTicketKeyPattern() {
    const explicit = cfg().get("ticketKeyPattern");
    if (explicit) {
        try {
            return new RegExp(explicit);
        }
        catch { /* fall through to default */ }
    }
    const projectKey = cfg().get("jiraProjectKey");
    if (projectKey) {
        try {
            return new RegExp(`${projectKey}-\\d+`);
        }
        catch { /* fall through */ }
    }
    return /[A-Za-z][A-Za-z0-9]*-\d+/;
}
function getTicketSystem() {
    return cfg().get("ticketSystem") || "jira";
}
function getTicketBaseUrl() {
    return cfg().get("ticketBaseUrl") || "";
}
/** Builds a link to the ticket in the configured ticketing system, if a base URL is set. */
function buildTicketUrl(storyId) {
    const base = getTicketBaseUrl();
    if (!base || !storyId) {
        return undefined;
    }
    return fillTemplate(base, { storyId });
}
/**
 * Extracts the story/ticket id from a branch name using the configured pattern.
 * Matches only against the part after the feature-branch prefix (e.g. "feature/") so a
 * broad ticketKeyPattern can never capture the prefix itself and get fed back into
 * featureBranchName(), which would double it up (e.g. "feature/feature/...").
 */
function extractStoryId(branch) {
    if (!branch) {
        return "";
    }
    const prefix = getFeatureBranchPrefix();
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
function sanitizeStoryId(input) {
    return input
        .trim()
        .replace(/[\s~^:?*[\]\\]+/g, "-") // git-forbidden / whitespace → "-"
        .replace(/[^A-Za-z0-9._-]+/g, "-") // anything else non-ref-safe → "-"
        .replace(/\.{2,}/g, "-") // ".." is forbidden in refs
        .replace(/-{2,}/g, "-")
        .replace(/^[-.\/]+|[-.\/]+$/g, ""); // no leading/trailing "-", ".", "/"
}
// ── Roles ────────────────────────────────────────────────────────────────────
function getRoles() {
    return cfg().get("roles") || ["Developer", "Lead", "Admin", "Data Load"];
}
/** True if the role's primary purpose is data loading (restricts sidebar to DM only). */
function isDataLoadRole(role) {
    return role === "Data Load";
}
/**
 * @deprecated Legacy fallback only — real role resolution goes through
 * RoleManager.getEffectiveRole(context), which is password-gated for Lead/Admin and
 * stored outside this freely-editable setting. This getter stays as the bootstrap
 * default for a fresh install (before anyone has ever changed role via that flow).
 */
function getCurrentRole() {
    return cfg().get("role") || "Developer";
}
const DEFAULT_ENVIRONMENTS = [
    { name: "dev" },
    { name: "qa", coverageGate: true },
    { name: "uat", requiredRole: "Lead" },
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
function getEnvironments() {
    const raw = cfg().get("environments");
    const list = (raw && raw.length > 0) ? raw : DEFAULT_ENVIRONMENTS;
    return list
        .filter((entry) => {
        // A malformed sfDevops.environments entry (null, {}, missing "name") would
        // otherwise throw deep inside every panel's refresh() with an unhelpful
        // "Cannot read properties of undefined" — skip it with a clear warning instead.
        const name = typeof entry === "string" ? entry : entry?.name;
        if (!name) {
            vscode.window.showWarningMessage(`Ignoring an sfDevops.environments entry with no "name" — check your settings.`);
            return false;
        }
        return true;
    })
        .map((entry, index) => {
        const e = typeof entry === "string" ? { name: entry } : entry;
        const isProd = e.isProd ?? (e.name === "prod");
        // The legacy sfDevops.devOrgAlias/prodOrgAlias settings were never part of an
        // environments[] entry itself — they're separate top-level settings keyed by
        // ROLE (first/publish stage, or whichever stage is Prod), not by name. Fall
        // back to them here so someone who configured an alias that way before this
        // machine-local store existed doesn't see it silently disappear.
        const legacyAlias = index === 0 ? cfg().get("devOrgAlias")
            : isProd ? cfg().get("prodOrgAlias")
                : undefined;
        return {
            name: e.name,
            label: e.label || e.name.toUpperCase(),
            branch: e.branch || e.name,
            icon: e.icon || "circle-outline",
            requiredRole: e.requiredRole,
            coverageGate: e.coverageGate ?? false,
            signoffGate: e.signoffGate ?? false,
            orgAlias: readOrgAliases()[e.name] || e.orgAlias || legacyAlias,
            // "RunRelevantTests" used to be the undocumented default here, but it isn't
            // one of the four values `sf project deploy` actually accepts (NoTestRun,
            // RunSpecifiedTests, RunLocalTests, RunAllTestsInOrg) — any deploy relying on
            // this default would fail outright. RunLocalTests (the CLI's own default when
            // no --test-level is passed) is the safe fallback; the Deployment Dashboard's
            // per-deploy "Tests to run" picker (auto-detected specified tests vs. run all)
            // is what actually delivers "run just the relevant tests" now.
            deployTestLevel: e.deployTestLevel || "RunLocalTests",
            isProd,
            locked: e.locked ?? false,
        };
    });
}
/**
 * Writes the environments array back to workspace settings (`.vscode/settings.json`).
 * Falls back to global settings if no workspace folder is open.
 */
async function saveEnvironments(envs) {
    const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration("sfDevops").update("environments", envs, target);
}
/** The first configured environment — published directly from the feature branch, no PR. */
function getPublishEnvironment() {
    return getEnvironments()[0];
}
/** Every environment after the first one — reached via promotion/validate branch + PR. */
function getPromotableEnvironments() {
    return getEnvironments().slice(1);
}
function findEnvironment(name) {
    return getEnvironments().find(e => e.name === name);
}
/** The environment (if any) whose coverageGate is set — used to gate the Apex coverage check. */
function getCoverageGateEnvironment() {
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
function getCoverageSourceOrg() {
    const devAlias = getDevOrgAlias();
    const gateEnv = getCoverageGateEnvironment();
    if (!gateEnv) {
        return { alias: devAlias, label: "Dev" };
    }
    const envs = getEnvironments();
    const idx = envs.findIndex(e => e.name === gateEnv.name);
    const prev = idx > 0 ? envs[idx - 1] : undefined;
    if (!prev || idx === 1) {
        // Gate sits right after the publish/dev stage — devOrgAlias is that stage's setting.
        return { alias: devAlias || prev?.orgAlias || "", label: "Dev" };
    }
    return { alias: prev.orgAlias || devAlias || "", label: prev.label };
}
/** True if `role` is allowed to run Promote & Deploy into `env` (Validate Only is always allowed). */
/**
 * True if `role` ranks at or above `env.requiredRole` in sfDevops.roles' configured order
 * (index 0 = lowest) — NOT a strict name match. sfDevops.roles is documented as a ranked
 * hierarchy ("Lead: everything Developer can, plus... Admin: everything") — a strict
 * equality check would mean Admin literally can't promote into a "Lead"-gated stage
 * (only someone whose role is exactly "Lead" could), which contradicts that model.
 */
function canPromote(role, env) {
    if (env.locked) {
        return false;
    } // locked beats all roles
    if (!env.requiredRole) {
        return true;
    }
    const roles = getRoles();
    const requiredRank = roles.indexOf(env.requiredRole);
    if (requiredRank === -1) {
        return role === env.requiredRole;
    } // requiredRole isn't even in sfDevops.roles — fall back to an exact match
    return roles.indexOf(role) >= requiredRank;
}
function getStaleStoryThresholdDays() {
    return cfg().get("staleStoryThresholdDays") ?? 14;
}
function getAuditLogRetentionDays() {
    return cfg().get("auditLogRetentionDays") ?? 90;
}
/** Message shown once a story has been merged into the last configured environment. */
function getTerminalStageMessage() {
    const envs = getEnvironments();
    const last = envs[envs.length - 1];
    const template = cfg().get("terminalStageMessage")
        || "Story deployed up to {lastEnvLabel}. Anything beyond this stage is handled outside this extension.";
    return fillTemplate(template, { lastEnvLabel: last?.label ?? "" });
}
// ── Git provider / repo identity ─────────────────────────────────────────────
function getGitProvider() {
    return cfg().get("gitProvider") || "bitbucket";
}
/** The raw sfDevops.gitProvider setting, or undefined if left unset — lets callers tell "unset" apart from "explicitly bitbucket" (getGitProvider() can't, since it applies the default itself). */
function getGitProviderRaw() {
    return cfg().get("gitProvider") || undefined;
}
/** Provider-neutral repo identity, falling back to the legacy Bitbucket-specific setting names. */
function getRepoWorkspace() {
    return cfg().get("repoWorkspace") || cfg().get("bitbucketWorkspace") || "";
}
function getRepoSlug() {
    return cfg().get("repoSlug") || cfg().get("bitbucketRepoSlug") || "";
}
// ── Coverage / source layout ─────────────────────────────────────────────────
function getCoverageThreshold() {
    return cfg().get("coverageThreshold") ?? 75;
}
function getCoverageTimeoutSeconds() {
    return cfg().get("coverageTimeoutSeconds") ?? 600;
}
function getDevOrgAlias() {
    return readOrgAliases().dev || cfg().get("devOrgAlias") || "";
}
/** Fallback only for when "prod" hasn't been added to sfDevops.environments as a real pipeline stage. */
function getProdOrgAlias() {
    return readOrgAliases().prod || cfg().get("prodOrgAlias") || "";
}
/**
 * "Demo" isn't a pipeline stage — no branch, no promotion, no gate — it's an optional
 * secondary org the Deployment Dashboard can deploy the SAME already-validated Prod
 * package to, in parallel, from Prod's own pane (see DeploymentDashboardPanel). Stored in
 * the same machine-local alias store as dev/qa/uat/prod, just under its own "demo" key —
 * deliberately not part of getOrgAliasSlots() (which mirrors getEnvironments() 1:1, and
 * Demo is never an environment in that sense).
 */
function getDemoOrgAlias() {
    return readOrgAliases().demo || "";
}
async function setDemoOrgAlias(alias) {
    await writeOrgAlias("demo", alias);
}
function getOrgAliasSlots() {
    // getEnvironments() already resolves each entry's orgAlias (machine-local store,
    // falling back to whatever's in settings) — just map it straight through.
    return getEnvironments().map(e => ({ key: e.name, label: e.label, alias: e.orgAlias ?? "" }));
}
/**
 * Saves an org alias for one of the 4 canonical slots to the machine-local store (see
 * the "Org aliases" section above) — never to settings.json, so it can't get lost to a
 * branch switch or reset by reinstalling the extension. getEnvironments()/getDevOrgAlias()/
 * getProdOrgAlias() all read this store first, so the change takes effect immediately.
 */
async function setOrgAliasSlot(key, alias) {
    await writeOrgAlias(key, alias);
}
function getSourceRootFolder() {
    return cfg().get("sourceRootFolder") || "force-app";
}
/** Timeout for a `sf project deploy start|validate` run, in seconds. */
function getDeployTimeoutSeconds() {
    return cfg().get("deployTimeoutSeconds") ?? 900;
}
/** When true, the "Salesforce-DevOps" output channel also prints every raw git/sf command this extension runs, the full CLI arguments, and job/deploy IDs with their live status — on top of the normal plain-language narration. Off by default: noisy, meant for debugging. */
function isVerboseLogsEnabled() {
    return cfg().get("enableVerboseLogs") ?? false;
}
// ── Misc ──────────────────────────────────────────────────────────────────────
function getStaleBranchThreshold() {
    return cfg().get("staleBranchThreshold") ?? 5;
}
/** How often the Story Progress sidebar re-checks state on its own, in seconds — a safety net only: real branch/file changes are picked up live via GitWatcher, this just covers whatever that can't see (e.g. remote-side changes like a merged PR). */
function getFallbackRefreshSeconds() {
    return cfg().get("fallbackRefreshSeconds") ?? 180;
}
// ── 2GP Packaging Release Gate (Dedicated 2GP Release Gate, triggered from the UAT
// branch) ─────────────────────────────────────────────────────────────────────
// A second, occasional track distinct from the day-to-day sprint flow above: it doesn't
// touch sfDevops.environments/baseBranch at all, it compares UAT against a separate
// packaging baseline branch and produces a 2GP beta PR. Everything it needs is under
// sfDevops.packaging so it stays fully settings-driven, same as the rest of this file.
function getPackageBaselineBranch() {
    return cfg().get("packageBaselineBranch") || "2gp-main";
}
/** Branch the 2GP gate reads its "what changed" diff from — defaults to the UAT environment's branch. */
function getPackagingSourceBranch() {
    const explicit = cfg().get("packagingSourceBranch");
    if (explicit) {
        return explicit;
    }
    const uat = findEnvironment("uat");
    return uat?.branch || "uat";
}
/** Role (from sfDevops.roles) required to run "Prepare 2GP Beta from UAT". Empty = unrestricted. */
function getPackagingRequiredRole() {
    return cfg().get("packagingRequiredRole") || "";
}
const DEFAULT_PACKAGING = {
    packageName: "",
    sourceBase: "force-app/main/default",
    managedTarget: "force-app/managed/main/default",
    unmanagedTarget: "force-app/unmanaged/main/default",
    docsDirectory: "docs/releases",
    patchOverrides: [],
    excludedMetadata: ["**/profiles/**", "**/settings/**"],
    devHubOrgAlias: "",
};
/** Everything the 2GP Release Gate needs — a single settings object, sfDevops.packaging. */
function getPackagingSettings() {
    const raw = cfg().get("packaging") || {};
    return {
        packageName: raw.packageName ?? DEFAULT_PACKAGING.packageName,
        sourceBase: raw.sourceBase ?? DEFAULT_PACKAGING.sourceBase,
        managedTarget: raw.managedTarget ?? DEFAULT_PACKAGING.managedTarget,
        unmanagedTarget: raw.unmanagedTarget ?? DEFAULT_PACKAGING.unmanagedTarget,
        docsDirectory: raw.docsDirectory ?? DEFAULT_PACKAGING.docsDirectory,
        patchOverrides: raw.patchOverrides ?? DEFAULT_PACKAGING.patchOverrides,
        excludedMetadata: raw.excludedMetadata ?? DEFAULT_PACKAGING.excludedMetadata,
        devHubOrgAlias: raw.devHubOrgAlias ?? DEFAULT_PACKAGING.devHubOrgAlias,
    };
}
//# sourceMappingURL=config.js.map