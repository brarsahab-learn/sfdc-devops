const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const sfCli = require("../out/SfCli.js");

    // ---- 1. checkDeployConflicts: parses the preview command's conflicts array ----
    {
        sfCli.execSf = async (args) => {
            if (args[2] === "preview") {
                return { stdout: JSON.stringify({ result: { conflicts: [
                    { fullName: "Utils", type: "ApexClass", filePath: "force-app/main/default/classes/Utils.cls" },
                    { fullName: "UtilsTest", type: "ApexClass", filePath: "force-app/main/default/classes/UtilsTest.cls" },
                ] } }) };
            }
            throw new Error("unexpected call: " + args.join(" "));
        };
        delete require.cache[require.resolve("../out/DeploymentEngine.js")];
        const { checkDeployConflicts } = require("../out/DeploymentEngine.js");

        const conflicts = await checkDeployConflicts("/tmp", "force-app", ["force-app/main/default/classes/Utils.cls"], "UAT-LIVE");
        check("returns both real conflicts", conflicts.length === 2, JSON.stringify(conflicts));
        check("carries the component name and type", conflicts[0].fullName === "Utils" && conflicts[0].type === "ApexClass", JSON.stringify(conflicts[0]));
    }

    // ---- 2. checkDeployConflicts: no source tracking / no conflicts -> empty, never throws ----
    {
        sfCli.execSf = async () => ({ stdout: JSON.stringify({ result: { conflicts: [] } }) });
        delete require.cache[require.resolve("../out/DeploymentEngine.js")];
        const { checkDeployConflicts } = require("../out/DeploymentEngine.js");
        const conflicts = await checkDeployConflicts("/tmp", "force-app", [], "PROD-LIVE");
        check("empty conflicts array for an org with no source tracking", conflicts.length === 0);
    }

    // ---- 3. checkDeployConflicts: a broken/unexpected response never crashes the real deploy that follows ----
    {
        sfCli.execSf = async () => { throw new Error("network blip"); };
        delete require.cache[require.resolve("../out/DeploymentEngine.js")];
        const { checkDeployConflicts } = require("../out/DeploymentEngine.js");
        const conflicts = await checkDeployConflicts("/tmp", "force-app", [], "UAT-LIVE");
        check("a failed preview check degrades to an empty list, doesn't throw", conflicts.length === 0);
    }

    // ---- 4. runDeploy (mode: deploy): conflicts found by the preview check flow through to the final result ----
    {
        sfCli.execSf = async (args) => {
            if (args[2] === "preview") {
                return { stdout: JSON.stringify({ result: { conflicts: [
                    { fullName: "Utils", type: "ApexClass", filePath: "force-app/main/default/classes/Utils.cls" },
                ] } }) };
            }
            return { stdout: JSON.stringify({ result: { id: "0Af1", done: true, status: "Succeeded", success: true, numberComponentsDeployed: 1, details: {} } }) };
        };
        delete require.cache[require.resolve("../out/DeploymentEngine.js")];
        const { runDeploy } = require("../out/DeploymentEngine.js");

        const result = await runDeploy("/tmp", "force-app", ["force-app/main/default/classes/Utils.cls"], "UAT-LIVE", "NoTestRun", 900, "deploy");
        check("a real deploy still succeeds despite the conflict (--ignore-conflicts)", result.success === true);
        check("the result carries what was actually overwritten", result.conflicts && result.conflicts.length === 1 && result.conflicts[0].fullName === "Utils", JSON.stringify(result.conflicts));
    }

    // ---- 5. runDeploy (mode: validate): never runs the conflict check at all — validate never touches the org ----
    {
        let previewCalled = false;
        sfCli.execSf = async (args) => {
            if (args[2] === "preview") { previewCalled = true; }
            return { stdout: JSON.stringify({ result: { id: "0Af1", done: true, status: "Succeeded", success: true, numberComponentsDeployed: 1, details: {} } }) };
        };
        delete require.cache[require.resolve("../out/DeploymentEngine.js")];
        const { runDeploy } = require("../out/DeploymentEngine.js");
        const result = await runDeploy("/tmp", "force-app", ["force-app/main/default/classes/Utils.cls"], "UAT-LIVE", "NoTestRun", 900, "validate");
        check("validate mode never calls the preview/conflict check", !previewCalled);
        check("validate result carries an empty conflicts list, not undefined", Array.isArray(result.conflicts) && result.conflicts.length === 0, JSON.stringify(result.conflicts));
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
