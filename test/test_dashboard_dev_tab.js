const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");

const panel = Object.create(DeploymentDashboardPanel.prototype);
panel._validatedSelections = new Map();
panel._lastOutcome = undefined;
panel._userRole = "Admin";

const devModel = {
    env: { name: "dev", label: "Dev", branch: "dev", orgAlias: "QA1-ZIB", isProd: false },
    nextEnv: { name: "qa", label: "QA", branch: "qa" },
    prevEnv: undefined,
    currentSha: "abc123", lastDeploy: null,
    groups: [{ storyId: "TEST_2", files: [{ path: "force-app/main/default/classes/Foo.cls", change: "added" }] }],
    allFiles: [{ path: "force-app/main/default/classes/Foo.cls", change: "added" }],
    fileDates: {},
    diffVsNext: [], packageXml: "<xml/>", unmapped: [],
    canDeploy: true, orgAliasSet: true,
    apexTestMap: { Foo: "FooTest" },
};

const html = panel._renderEnvPane(devModel);
const checks = [
    ["dev pane renders", html.includes('data-env="dev"')],
    ["dev has real files, not bootstrap-only", !html.includes("nothing to individually select")],
    ["dev has Validate/Deploy buttons", html.includes("runAction('dev','validate')") && html.includes('id="deployBtn-dev"')],
];

let allPass = true;
for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
    if (!pass) { allPass = false; }
}
process.exit(allPass ? 0 : 1);
