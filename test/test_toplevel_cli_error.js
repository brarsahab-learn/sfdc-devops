const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const sfCli = require("../out/SfCli.js");

async function run(execSfStub) {
    sfCli.execSf = execSfStub;
    delete require.cache[require.resolve("../out/DeploymentEngine.js")];
    const { runDeploy } = require("../out/DeploymentEngine.js");
    return runDeploy("/tmp", "force-app", [], "QA-LIVE", "RunSpecifiedTests", 900, "validate", ["UtilsTest", "tempTest"]);
}

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // Reproduces the exact bug report: a bare top-level CLI error object (no "result" key
    // at all) — e.g. an argument/auth/permission failure that happens BEFORE a deploy result
    // is ever produced. Previously `parsed?.result ?? {}` silently treated this as an empty
    // (but present) deploy result, so no detail-extraction branch ever found anything,
    // producing the bare "Deploy did not succeed... no further detail" the user saw twice
    // against two different orgs.
    const r1 = await run(async () => ({
        stdout: JSON.stringify({
            status: 1,
            name: "SpecifiedTestsNotInPackageError",
            message: "The tests specified in the --tests property must be in the deployment package.",
            exitCode: 1,
        }),
    }));
    const pass1 = r1.error && r1.error.includes("must be in the deployment package") && !r1.error.includes("no further detail");
    console.log(`${pass1 ? "PASS" : "FAIL"}: top-level CLI error object surfaces its real message — got: "${r1.error}"`);
    if (!pass1) allPass = false;

    // A genuinely empty/unknown result (result key present but empty) should still fall to
    // the last-resort generic message — confirms we didn't break that case while fixing this one.
    const r2 = await run(async () => ({
        stdout: JSON.stringify({ result: { id: "0Af1", status: "Failed", success: false } }),
    }));
    const pass2 = r2.error && r2.error.includes("no further detail");
    console.log(`${pass2 ? "PASS" : "FAIL"}: genuinely empty deploy result still falls to the generic message — got: "${r2.error}"`);
    if (!pass2) allPass = false;

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
