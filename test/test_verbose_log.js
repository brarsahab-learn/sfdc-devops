const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const lines = [];
let shown = 0;
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
fakeVscode.window.createOutputChannel = () => ({
    appendLine: (l) => lines.push(l),
    show: () => { shown++; },
    dispose: () => {},
});

const config = require("../out/config.js");
let verboseEnabled = false;
config.isVerboseLogsEnabled = () => verboseEnabled;

const Log = require("../out/Log.js");

Log.debugLog("should not appear");
const checks = [];
checks.push(["disabled: no lines appended", lines.length === 0]);
checks.push(["disabled: channel not shown", shown === 0]);

verboseEnabled = true;
Log.debugLog("$ sf project deploy start --source-dir force-app");
checks.push(["enabled: line appended", lines.some(l => l.includes("$ sf project deploy start"))]);
checks.push(["enabled: channel shown once", shown === 1]);

Log.debugLog("$ git status");
checks.push(["enabled: second line appended", lines.length === 2]);
checks.push(["enabled: channel not shown again", shown === 1]);

let allPass = true;
for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
    if (!pass) { allPass = false; }
}
process.exit(allPass ? 0 : 1);
