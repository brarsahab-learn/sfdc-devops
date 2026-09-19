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
    return runDeploy("/tmp", "force-app", [], "QA-LIVE", "RunLocalTests", 900, "deploy");
}

(async () => {
    let allPass = true;

    // Case 1: component failures present — must NOT fall back to the generic message.
    const r1 = await run(async () => ({
        stdout: JSON.stringify({ result: { id: "0Af1", status: "Failed", success: false, details: {
            componentFailures: [{ fullName: "Utils", componentType: "ApexClass", problem: "Invalid type: Foo" }],
        } } }),
    }));
    const pass1 = r1.error && r1.error.includes("Utils: Invalid type: Foo") && !/^Deploy did not succeed\.?$/.test(r1.error);
    console.log(`${pass1 ? "PASS" : "FAIL"}: component failure surfaces real detail — got: "${r1.error}"`);
    if (!pass1) allPass = false;

    // Case 2: test failures only, no component failures. Uses the REAL field name the
    // Salesforce API's RunTestsResult actually returns (numFailures, failures[]) — a prior
    // version of this test used the wrong name (numberTestsFailed), which is why the bug
    // this covers (a real test failure showing only "no further detail") went unnoticed.
    const r2 = await run(async () => ({
        stdout: JSON.stringify({ result: { id: "0Af1", status: "Failed", success: false, details: {
            runTestResult: {
                numFailures: 2, numTestsRun: 10,
                failures: [
                    { name: "UtilsTest", methodName: "testIdConversion", message: "System.AssertException: Assertion Failed: Expected: 1, Actual: 0" },
                    { name: "AccountTriggerTest", methodName: "testBulkInsert", message: "System.NullPointerException: Attempt to de-reference a null object" },
                ],
            },
        } } }),
    }));
    const pass2 = r2.error === "2 of 10 test(s) failed — UtilsTest.testIdConversion: System.AssertException: Assertion Failed: Expected: 1, Actual: 0; AccountTriggerTest.testBulkInsert: System.NullPointerException: Attempt to de-reference a null object";
    console.log(`${pass2 ? "PASS" : "FAIL"}: test failure surfaces real detail — got: "${r2.error}"`);
    if (!pass2) allPass = false;

    // Case 2b: legacy field name (numberTestsFailed) still works as a fallback, no message detail.
    const r2b = await run(async () => ({
        stdout: JSON.stringify({ result: { id: "0Af2", status: "Failed", success: false, details: {
            runTestResult: { numberTestsFailed: 2, numTestsRun: 10 },
        } } }),
    }));
    const pass2b = r2b.error === "2 of 10 test(s) failed.";
    console.log(`${pass2b ? "PASS" : "FAIL"}: legacy field name still falls back correctly — got: "${r2b.error}"`);
    if (!pass2b) allPass = false;

    // Case 3: genuinely nothing — still a real, non-bare message with status included.
    const r3 = await run(async () => ({
        stdout: JSON.stringify({ result: { id: "0Af1", status: "Canceled", success: false } }),
    }));
    const pass3 = r3.error && r3.error.includes("Canceled") && r3.error !== "Deploy did not succeed.";
    console.log(`${pass3 ? "PASS" : "FAIL"}: unknown-shape failure still includes status — got: "${r3.error}"`);
    if (!pass3) allPass = false;

    process.exit(allPass ? 0 : 1);
})();
