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

    // ---- 1. Real-time progress: async start, then poll until done, reporting each step ----
    {
        let call = 0;
        const responses = [
            // "project deploy start --async" — queued immediately, no numbers yet.
            { stdout: JSON.stringify({ result: { id: "0Af000", done: false, status: "Queued" } }) },
            // First poll — in progress.
            { stdout: JSON.stringify({ result: { id: "0Af000", done: false, status: "InProgress", numberComponentsDeployed: 2, numberComponentsTotal: 5, numberTestsCompleted: 0, numberTestsTotal: 3 } }) },
            // Second poll — done, succeeded.
            { stdout: JSON.stringify({ result: { id: "0Af000", done: true, status: "Succeeded", success: true, numberComponentsDeployed: 5, numberComponentsTotal: 5, details: { runTestResult: { numTestsRun: 3, numberTestsFailed: 0 } } } }) },
        ];
        sfCli.execSf = async (args) => {
            const r = responses[Math.min(call, responses.length - 1)];
            call++;
            return r;
        };

        delete require.cache[require.resolve("../out/DeploymentEngine.js")];
        const orig = global.setTimeout;
        global.setTimeout = (fn) => orig(fn, 0); // don't actually wait 3s per poll in the test
        const { runDeploy } = require("../out/DeploymentEngine.js");

        const statuses = [];
        const result = await runDeploy("/tmp", "force-app", [], "QA-LIVE", "RunLocalTests", 60, "deploy", undefined, s => statuses.push(s));
        global.setTimeout = orig;

        check("started async and polled report at least twice", call >= 3, call);
        check("progress callback fired with live component/test counts", statuses.some(s => s.includes("2/5 component(s)")), JSON.stringify(statuses));
        check("final result reflects the DONE poll, not the initial queued one", result.success === true && result.numberComponentsDeployed === 5);
    }

    // ---- 2. Timeout: never reaches done before the deadline ----
    {
        sfCli.execSf = async () => ({ stdout: JSON.stringify({ result: { id: "0Af111", done: false, status: "InProgress" } }) });
        delete require.cache[require.resolve("../out/DeploymentEngine.js")];
        const orig = global.setTimeout;
        global.setTimeout = (fn) => orig(fn, 0);
        const { runDeploy } = require("../out/DeploymentEngine.js");
        // timeoutSeconds is tiny (0) so the deadline is already passed after the first check.
        const result = await runDeploy("/tmp", "force-app", [], "QA-LIVE", "RunLocalTests", 0, "deploy");
        global.setTimeout = orig;
        check("times out cleanly instead of hanging or crashing", result.error && result.error.includes("Timed out"), result.error);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
