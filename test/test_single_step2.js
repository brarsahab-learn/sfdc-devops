const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const { StoryWebviewProvider } = require("../out/providers/StoryWebviewProvider.js");
const config = require("../out/config.js");

config.getEnvironments = () => [
    { name: "dev", label: "Dev", branch: "dev", isProd: false },
    { name: "qa", label: "QA", branch: "qa", requiredRole: "Lead", isProd: false },
    { name: "uat", label: "UAT", branch: "uat", isProd: false },
];
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev" });
config.getPromotableEnvironments = () => [
    { name: "qa", label: "QA", branch: "qa", requiredRole: "Lead", isProd: false },
    { name: "uat", label: "UAT", branch: "uat", isProd: false },
];
config.getCoverageGateEnvironment = () => undefined;
config.getCurrentRole = () => "Admin";

const provider = Object.create(StoryWebviewProvider.prototype);
provider._bbClient = { buildPrUrl: () => "https://example.com/pr/1" };
provider._extContext = {
    extension: { packageJSON: { version: "3.13.1" } },
    globalState: { get: () => undefined, update: async () => undefined },
};
provider._forceShowSetup = false;

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

// Brand-new story: dev not yet published at all, but qa/uat somehow carry stale "open"/"merged" state.
const progress = { dev: "none", qa: "open", uat: "merged" };
const html = provider._getWebviewHtml("feature/TEST-9", "TEST-9", progress, 0, undefined, undefined, true, undefined, {});

check("Dev is current (not future/locked)", !/Dev<span class="pstatus">Waiting/.test(html));
check("Dev shows Commit & Publish CTA", html.includes("Commit &amp; Publish Feature Branch"));
check("QA is locked/future despite raw 'open' state", /QA<span class="pstatus">Waiting for Dev/.test(html));
check("UAT is locked/future despite raw 'merged' state", /UAT<span class="pstatus">Waiting for Dev/.test(html));
check("QA promote/deploy icons suppressed", !html.includes("send('promote', 'qa')") && !html.includes("openDeploymentDashboard', 'qa'"));
check("UAT promote/deploy icons suppressed", !html.includes("send('promote', 'uat')") && !html.includes("openDeploymentDashboard', 'uat'"));
check("QA's PR link (🔗) also suppressed while locked", !/QA[\s\S]{0,400}example\.com\/pr\/1/.test(html.split("UAT")[0]));

process.exit(allPass ? 0 : 1);
