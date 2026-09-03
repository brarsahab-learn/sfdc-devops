const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
fakeVscode.workspace.getConfiguration = () => ({ get: () => undefined });

const { EnvironmentTreeProvider } = require("../out/providers/EnvironmentTreeProvider.js");
const config = require("../out/config.js");
config.getEnvironments = () => [
    { name: "dev", label: "DEV", branch: "dev", icon: "circle-outline", orgAlias: "insurebridge-live--dev" },
    { name: "qa", label: "QA", branch: "qa", icon: "circle-outline" }, // deliberately no orgAlias
];

const gh = {
    getDeployState: async (env) => env === "dev" ? { sha: "abcdef1234567890", deployedAt: "2026-09-02T10:00:00Z", numberComponentsDeployed: 3 } : null,
    remoteHeadSha: async () => "abcdef1234567890",
};

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const provider = new EnvironmentTreeProvider(gh);
    const items = await provider.getChildren();
    check("2 env items returned", items.length === 2);
    for (const item of items) {
        check(`${item.label} has a click command bound to openDeploymentDashboard`, item.command && item.command.command === "sfDevops.openDeploymentDashboard", JSON.stringify(item.command));
    }
    check("DEV command arg is 'dev'", items[0].command.arguments[0] === "dev");
    check("QA command arg is 'qa'", items[1].command.arguments[0] === "qa");

    check("DEV description leads with the org alias, then branch, then deploy state", items[0].description === "insurebridge-live--dev · dev · abcdef12", items[0].description);
    check("QA (no orgAlias configured) shows an explicit gap instead of vanishing", items[1].description.includes("no org alias set"), items[1].description);
    check("QA description still shows its branch name", items[1].description.includes("· qa ·"), items[1].description);
    check("DEV tooltip includes the org line", items[0].tooltip.includes("Org: insurebridge-live--dev"), items[0].tooltip);
    process.exit(allPass ? 0 : 1);
})();
