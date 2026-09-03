// test/run.js — runs every test in this folder and reports a summary.
//
// These are compiled-JS integration tests, not a framework like Jest/Mocha: each file is a
// self-contained script that stubs the `vscode` module (test/fake-vscode.js) and requires the
// real compiled output from ../out/, so they exercise actual extension logic (GitHelper,
// promoteStory, DeploymentEngine, the webview providers, ...) without needing a real VS Code
// window. Run `npm run compile` first — `npm test` does this for you.
//
// A handful of files (anything using SF_DEVOPS_TEST_REPO) need a real Salesforce DX git repo
// to run against and SKIP themselves cleanly (exit 0, no failure) when one isn't configured —
// see README.md in this folder for how to point them at one.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs.readdirSync(dir)
    .filter(f => (f.startsWith("test_") || f.startsWith("e2e_")) && f.endsWith(".js"))
    .sort();

let passed = 0, failed = 0, skipped = 0;
const failures = [];

for (const f of files) {
    process.stdout.write(`${f} ... `);
    try {
        const out = execFileSync("node", [path.join(dir, f)], { encoding: "utf8", timeout: 120_000 });
        if (out.includes("SKIP")) {
            skipped++;
            console.log("SKIP");
        } else {
            passed++;
            console.log("PASS");
        }
    } catch (e) {
        failed++;
        failures.push(f);
        console.log("FAIL");
        const output = (e.stdout || "") + (e.stderr || "");
        console.log(output.split("\n").slice(-15).map(l => "    " + l).join("\n"));
    }
}

console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed (${files.length} file(s) total)`);
if (failures.length > 0) {
    console.log("Failed: " + failures.join(", "));
    process.exit(1);
}
