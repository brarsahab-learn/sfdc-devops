const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const config = require("../out/config.js");
config.getEnvironments = () => [
    { name: "dev", label: "Dev", branch: "dev" },
    { name: "qa", label: "QA", branch: "qa" },
];
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev" });

const { getStoryTimelines } = require("../out/StoryProgress.js");
const { StoryWebviewProvider } = require("../out/providers/StoryWebviewProvider.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- 1. getStoryTimelines: dev (publish+deploy), qa (validate+promote+deploy) ----
    const auditEntries = [
        { operation: "commitAndPublish", storyId: "TEST-9", targetEnv: undefined, outcome: "success", timestamp: "2026-08-01T10:00:00.000Z" },
        { operation: "promote", storyId: "TEST-9", targetEnv: "qa", outcome: "success", timestamp: "2026-08-02T11:00:00.000Z" },
        { operation: "promote", storyId: "TEST-9", targetEnv: "qa", outcome: "failure", timestamp: "2026-08-02T09:00:00.000Z" }, // must be ignored (not success)
    ];
    const gh = {
        getAuditEntries: async () => auditEntries,
        storyCommitShaOnBranch: async (branch) => (branch === "dev" ? "sha-dev" : null), // deployed on dev, not qa
        getDeployState: async (env) => (env === "dev" ? { sha: "sha-dev", deployedAt: "2026-08-01T12:00:00.000Z" } : null),
        isAncestorSha: async () => true,
        getPromotionValidationRecord: async (storyId, env) => (env === "qa" ? { passed: true, date: "2026-08-02T10:30:00.000Z" } : null),
    };

    const timelines = await getStoryTimelines(gh, "TEST-9");
    check("dev.published is done with the right timestamp", timelines.dev.published.done && timelines.dev.published.at === "2026-08-01T10:00:00.000Z");
    check("dev.deployment is done (deployed)", timelines.dev.deployment.done && timelines.dev.deployment.at === "2026-08-01T12:00:00.000Z");
    check("qa.validation is done from the dedicated record", timelines.qa.validation.done && timelines.qa.validation.at === "2026-08-02T10:30:00.000Z");
    check("qa.promotion picks the SUCCESSFUL entry, ignoring the failed one", timelines.qa.promotion.done && timelines.qa.promotion.at === "2026-08-02T11:00:00.000Z");
    check("qa.deployment is still pending (not deployed there)", timelines.qa.deployment.done === false);

    // Empty storyId -> empty timelines, no throw
    const empty = await getStoryTimelines(gh, "");
    check("empty storyId returns {} without throwing", Object.keys(empty).length === 0);

    // ---- 2. Rendering: badges + accordion appear per stage ----
    config.getEnvironments = () => [
        { name: "dev", label: "Dev", branch: "dev", isProd: false },
        { name: "qa", label: "QA", branch: "qa", isProd: false },
    ];
    config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", isProd: false }];
    config.getCoverageGateEnvironment = () => undefined;
    config.getCurrentRole = () => "Admin";

    const provider = Object.create(StoryWebviewProvider.prototype);
    provider._bbClient = { buildPrUrl: () => null };
    provider._extContext = {
        extension: { packageJSON: { version: "3.19.0" } },
        globalState: { get: () => undefined, update: async () => undefined },
    };
    provider._forceShowSetup = false;

    const progress = { dev: "published", qa: "open" };
    const html = provider._getWebviewHtml("feature/TEST-9", "TEST-9", progress, 0, undefined, undefined, {}, undefined, timelines);

    check("stage badges rendered for dev row", (html.match(/class="stage-badge/g) || []).length >= 4); // 2 for dev + 3 for qa = 5, at least a handful
    check("accordion present for each stage", (html.match(/class="stage-timeline"/g) || []).length === 2);
    check("qa accordion shows the real validated date/time (not just 'Pending')", html.includes(new Date("2026-08-02T10:30:00.000Z").toLocaleString()));
    check("qa accordion shows Deployed as Pending (not deployed there)", /Deployed<\/span><span class="stage-when pending">Pending/.test(html));
    check("no unresolved template artifacts", !/undefined|\[object Object\]/.test(html));

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
