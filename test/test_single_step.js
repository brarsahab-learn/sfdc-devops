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
    extension: { packageJSON: { version: "3.12.2" } },
    globalState: { get: () => undefined, update: async () => undefined },
};
provider._forceShowSetup = false;

// This is exactly the reported scenario: QA merged (current, real "ready to deploy" stage)
// but UAT is ALSO already "merged" (stale/grandfathered pre-gate data) — must not render as
// a second simultaneously-actionable stage.
const progress = { dev: "published", qa: "merged", uat: "merged" };
const html = provider._getWebviewHtml("feature/TEST-1", "TEST-1", progress, 0, undefined, undefined, true, undefined, {});

const checks = [
    ["QA is the current stage with its real CTA", html.includes("QA's PR is merged")],
    ["QA still shows live Deploy button", html.includes("send('openDeploymentDashboard', 'qa')")],
    ["UAT is rendered as locked/future", /UAT<span class="pstatus">Waiting for QA/.test(html)],
    ["UAT's promote icon (⬆) is suppressed", !html.includes("send('promote', 'uat')")],
    ["UAT's deploy icon (🚀 open dashboard) is suppressed", !html.includes("send('openDeploymentDashboard', 'uat')")],
    ["UAT step has the 'future' class", /class="pstep future"/.test(html) || /class="pstep [a-z]* ?future/.test(html)],
    ["Dev row still shows its own deploy link once published", html.includes("openDeploymentDashboard', 'dev'")],
];

let allPass = true;
for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
    if (!pass) { allPass = false; }
}

// Terminal case: everything deployed — currentEnvName is null, nothing should be "future"-locked.
const progress2 = { dev: "published", qa: "deployed", uat: "deployed" };
const html2 = provider._getWebviewHtml("feature/TEST-1", "TEST-1", progress2, 0, undefined, undefined, true, undefined, {});
const noFutureWhenTerminal = !/class="pstep[^"]*future/.test(html2);
console.log(`${noFutureWhenTerminal ? "PASS" : "FAIL"}: terminal state has no locked/future rows`);
if (!noFutureWhenTerminal) { allPass = false; }

process.exit(allPass ? 0 : 1);
