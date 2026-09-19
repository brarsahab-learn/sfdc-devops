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
    let capturedArgs = [];
    sfCli.execSf = async (args) => {
        capturedArgs.push(args);
        // First call is the async start; return a terminal Succeeded result immediately so
        // the poll loop never needs a second (report) call for this test.
        return { stdout: JSON.stringify({ result: { id: "0Af1", done: true, status: "Succeeded", success: true, numberComponentsDeployed: 1, details: {} } }) };
    };

    delete require.cache[require.resolve("../out/DeploymentEngine.js")];
    const { runDeploy } = require("../out/DeploymentEngine.js");

    // ---- 1. A real deploy (mode: "deploy") always passes --ignore-conflicts ----
    // (a "project deploy preview" conflict check runs first now — see test_org_conflicts.js —
    // so the actual start call has to be found by command, not assumed to be the first call.)
    capturedArgs = [];
    await runDeploy("/tmp", "force-app", ["force-app/main/default/classes/Foo.cls"], "UAT-LIVE", "NoTestRun", 900, "deploy");
    const startArgs = capturedArgs.find(a => a[2] === "start");
    check("deploy start includes --ignore-conflicts", startArgs && startArgs.includes("--ignore-conflicts"), JSON.stringify(startArgs));
    check("deploy start command is 'project deploy start'", startArgs && startArgs[0] === "project" && startArgs[1] === "deploy" && startArgs[2] === "start");

    // ---- 2. Validate (check-only) never sends the flag — deploy validate doesn't support it ----
    capturedArgs = [];
    await runDeploy("/tmp", "force-app", ["force-app/main/default/classes/Foo.cls"], "UAT-LIVE", "NoTestRun", 900, "validate");
    check("validate does NOT include --ignore-conflicts", !capturedArgs[0].includes("--ignore-conflicts"), JSON.stringify(capturedArgs[0]));
    check("validate command is 'project deploy validate'", capturedArgs[0][0] === "project" && capturedArgs[0][1] === "deploy" && capturedArgs[0][2] === "validate");

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
