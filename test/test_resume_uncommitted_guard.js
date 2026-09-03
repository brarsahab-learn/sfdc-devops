const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
let lastWarningMsg = null;
fakeVscode.window.showWarningMessage = async (msg) => { lastWarningMsg = msg; return undefined; };
fakeVscode.window.showInformationMessage = async () => undefined;
fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });
fakeVscode.ProgressLocation = { Notification: 1 };

const config = require("../out/config.js");
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];

const { resumePromotion } = require("../out/commands/resumePromotion.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

function makeGitHelper(overrides) {
    return Object.assign({
        tryBeginOperation: () => true,
        endOperation: () => {},
        getPendingOperation: async () => ({ kind: "promotion", storyId: "TEST-9", targetEnv: "qa", mode: "promote" }),
        continuePendingOperation: async () => ({ status: "clean", branch: "promotion/TEST-9-to-qa", conflicts: [] }),
        appendAudit: async () => {},
        hasUncommittedChanges: async () => false,
        workingTreeFiles: async () => [],
        stagedFiles: async () => [],
        currentBranch: async () => "promotion/TEST-9-to-qa",
        finalizePromotion: async () => ({ branch: "promotion/TEST-9-to-qa", tag: "" }),
    }, overrides);
}

(async () => {
    const storyProvider = { refresh: () => {} };

    // ---- Uncommitted changes lingering after conflict resolution -> hard block ----
    {
        let finalizeCalled = false;
        const gh = makeGitHelper({
            hasUncommittedChanges: async () => true,
            finalizePromotion: async () => { finalizeCalled = true; return { branch: "x", tag: "" }; },
        });
        await resumePromotion({}, gh, storyProvider);
        check("resume hard-blocks on uncommitted changes", lastWarningMsg && lastWarningMsg.includes("Commit or stash your local changes"), lastWarningMsg);
        check("never pushes the promotion branch when blocked", !finalizeCalled);
    }

    // ---- Clean working tree -> proceeds normally, no block ----
    {
        lastWarningMsg = null;
        let finalizeCalled = false;
        const gh = makeGitHelper({
            finalizePromotion: async () => { finalizeCalled = true; return { branch: "x", tag: "" }; },
        });
        await resumePromotion({}, gh, storyProvider);
        check("clean tree proceeds to push the promotion branch", finalizeCalled);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
