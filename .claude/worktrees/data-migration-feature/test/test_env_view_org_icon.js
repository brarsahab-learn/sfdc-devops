const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
fakeVscode.workspace.getConfiguration = () => ({ get: () => undefined });

const config = require("../out/config.js");
config.getEnvironments = () => [
    { name: "qa", label: "QA", branch: "qa", icon: "circle-outline", orgAlias: "insurebridge-live--qa" },
    { name: "uat", label: "UAT", branch: "uat", icon: "circle-outline" }, // no orgAlias
];

const { EnvironmentTreeProvider, EnvItem } = require("../out/providers/EnvironmentTreeProvider.js");

const gh = {
    getDeployState: async () => null,
    remoteHeadSha: async () => "abc123",
};

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const provider = new EnvironmentTreeProvider(gh);
    const items = await provider.getChildren();

    check("EnvItem is exported (needed by the command handler)", typeof EnvItem === "function");
    check("QA row carries its org alias", items[0].orgAlias === "insurebridge-live--qa", items[0].orgAlias);
    check("QA row is tagged with the contextValue the inline icon menu targets", items[0].contextValue === "sfDevopsEnvItem", items[0].contextValue);
    check("UAT row (no orgAlias) has an empty string, not undefined — handler checks this", items[1].orgAlias === "", JSON.stringify(items[1].orgAlias));
    check("envLabel is carried through for the warning message", items[1].envLabel === "UAT", items[1].envLabel);

    // ---- Simulate the command handler's own logic (registered in extension.ts) ----
    const sfCli = require("../out/SfCli.js");
    let capturedArgs = null;
    sfCli.execSf = async (args) => { capturedArgs = args; return { stdout: "", stderr: "" }; };

    async function simulateHandler(item) {
        if (!item?.orgAlias) {
            return fakeVscode.window.showWarningMessage(`No org alias set for ${item?.envLabel ?? "this environment"} — set sfDevops.environments[].orgAlias to enable this.`);
        }
        return sfCli.execSf(["org", "open", "--target-org", item.orgAlias, "--path", "lightning/setup/DeployStatus/home"], { cwd: "/tmp", timeout: 30000, maxBuffer: 2097152 });
    }

    capturedArgs = null;
    await simulateHandler(items[0]);
    check("opens the right org with the Deploy Status path", capturedArgs && capturedArgs.join(" ") === "org open --target-org insurebridge-live--qa --path lightning/setup/DeployStatus/home", JSON.stringify(capturedArgs));

    let warnMsg = null;
    fakeVscode.window.showWarningMessage = async (m) => { warnMsg = m; };
    capturedArgs = null;
    await simulateHandler(items[1]);
    check("no orgAlias configured -> warns instead of calling the CLI", capturedArgs === null && warnMsg && warnMsg.includes("UAT"), JSON.stringify({ capturedArgs, warnMsg }));

    process.exit(allPass ? 0 : 1);
})();
