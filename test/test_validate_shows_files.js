const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
let lastWarningMsg = null;
fakeVscode.window.showWarningMessage = async (msg) => { lastWarningMsg = msg; return undefined; }; // simulate Cancel
fakeVscode.window.showInformationMessage = async () => undefined;

const config = require("../out/config.js");
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa" }];
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];
config.findEnvironment = (name) => ({ name, label: name.toUpperCase(), branch: name });
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;
config.getCoverageGateEnvironment = () => undefined;

const { runPromotion } = require("../out/commands/promoteStory.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const gh = {
        tryBeginOperation: () => true,
        endOperation: () => {},
        currentBranch: async () => "feature/TEST-9",
        resolveRepoIdentity: async () => undefined,
        checkPrevEnvDeployed: async () => ({ blocked: false }),
        getPendingOperation: async () => null,
        isSignoffPassed: async () => true,
        promotionBranchExists: async () => false,
        hasUncommittedChanges: async () => false,
        previewStoryFiles: async () => [
            { path: "force-app/main/default/classes/Foo.cls", change: "modified" },
            { path: "force-app/main/default/classes/Bar.cls", change: "added" },
        ],
    };
    const bbClient = { getOpenPRUrl: async () => null };

    // ---- Validate Only now shows the file list too, same as Promote ----
    lastWarningMsg = null;
    await runPromotion(bbClient, gh, "TEST-9", "qa", "validate", { refresh: () => {} });
    check("Validate confirm includes the file count", lastWarningMsg && lastWarningMsg.includes("2 file(s)"), lastWarningMsg);
    check("Validate confirm lists the actual paths", lastWarningMsg && lastWarningMsg.includes("Foo.cls") && lastWarningMsg.includes("Bar.cls"));

    // ---- Nothing to validate: wording says "validate against", not "promote to" ----
    lastWarningMsg = null;
    let infoMsg = null;
    fakeVscode.window.showInformationMessage = async (msg) => { infoMsg = msg; return undefined; };
    gh.previewStoryFiles = async () => [];
    await runPromotion(bbClient, gh, "TEST-9", "qa", "validate", { refresh: () => {} });
    check("nothing-to-validate uses validate-specific wording", infoMsg && infoMsg.includes("nothing new to validate against"), infoMsg);
    check("no confirm dialog shown for the nothing-to-validate case", lastWarningMsg === null);

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
