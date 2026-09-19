const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

const { GitHelper, warnUncommittedChanges } = require("../out/GitHelper.js");

(async () => {
    // ---- 1. warnUncommittedChanges: offerStash shows the option and returns the stash label ----
    {
        const gh = Object.create(GitHelper.prototype);
        gh.workingTreeFiles = async () => ["force-app/main/default/classes/Foo.cls"];
        gh.stagedFiles = async () => [];
        gh.currentBranch = async () => "feature/TEST-1";
        let stashedLabel = null;
        gh.stashUnstagedChanges = async (label) => { stashedLabel = label; return true; };

        let seenActions = null;
        fakeVscode.window.showWarningMessage = async (msg, ...actions) => { seenActions = actions; return "Stash & Continue"; };

        const result = await warnUncommittedChanges(gh, "Commit or stash first.", { offerStash: true });
        check("offers a Stash & Continue action", seenActions.includes("Stash & Continue"), JSON.stringify(seenActions));
        check("returns the stash label it actually used", result !== null && result === stashedLabel, result);
    }

    // ---- 2. Declining still returns null (no stash), same as before ----
    {
        const gh = Object.create(GitHelper.prototype);
        gh.workingTreeFiles = async () => ["force-app/main/default/classes/Foo.cls"];
        gh.stagedFiles = async () => [];
        gh.currentBranch = async () => "feature/TEST-1";
        gh.stashUnstagedChanges = async () => { throw new Error("should not be called"); };
        fakeVscode.window.showWarningMessage = async () => undefined; // user dismissed
        fakeVscode.commands = { executeCommand: async () => undefined };
        const result = await warnUncommittedChanges(gh, "Commit or stash first.", { offerStash: true });
        check("dismissing returns null — caller must stop", result === null);
    }

    // ---- 3. Without offerStash, no Stash & Continue action is offered at all (existing callers unaffected) ----
    {
        const gh = Object.create(GitHelper.prototype);
        gh.workingTreeFiles = async () => ["force-app/main/default/classes/Foo.cls"];
        gh.stagedFiles = async () => [];
        gh.currentBranch = async () => "main";
        let seenActions = null;
        fakeVscode.window.showWarningMessage = async (msg, ...actions) => { seenActions = actions; return undefined; };
        await warnUncommittedChanges(gh, "Commit or stash first.");
        check("no offerStash => no Stash & Continue action shown", !seenActions.includes("Stash & Continue"), JSON.stringify(seenActions));
    }

    // ---- 4. runPromotion end-to-end: uncommitted changes -> Stash & Continue -> proceeds, then restores the stash ----
    {
        const config = require("../out/config.js");
        config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", deployTestLevel: "RunLocalTests" }];
        config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];
        config.findEnvironment = (n) => config.getEnvironments().find(e => e.name === n);
        config.getCoverageGateEnvironment = () => undefined;
        config.promoBranchName = (s, e, m) => `${m}/${s}-to-${e}`;
        config.featureBranchName = (id) => `feature/${id}`;

        delete require.cache[require.resolve("../out/commands/promoteStory.js")];
        const { runPromotion } = require("../out/commands/promoteStory.js");

        const events = [];
        const gh = Object.create(GitHelper.prototype);
        gh._inFlightOperations = new Set();
        gh.currentBranch = async () => "feature/TEST-9";
        gh.checkoutBranch = async (b) => { events.push(`checkout:${b}`); };
        gh.hasUncommittedChanges = async () => events.filter(e => e === "stashed").length === 0; // dirty until stashed
        gh.workingTreeFiles = async () => ["force-app/main/default/classes/Foo.cls"];
        gh.stagedFiles = async () => [];
        gh.stashUnstagedChanges = async (label) => { events.push("stashed"); return true; };
        gh.restoreStash = async (label) => { events.push("restored"); return { status: "restored" }; };
        gh.checkPrevEnvDeployed = async () => ({ blocked: false });
        gh.isSignoffPassed = async () => true;
        gh.promotionBranchExists = async () => false;
        gh.previewStoryFiles = async () => [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }];
        gh.conflictingPendingOperation = async () => undefined;
        gh.beginPromotion = async () => ({ status: "clean", branch: "promote/TEST-9-to-qa", conflicts: [] });
        gh.finalizePromotion = async () => ({ branch: "promote/TEST-9-to-qa", tag: "" });
        gh.createLocalBranchFrom = async () => {};
        gh.diffNameStatusBetween = async () => [];
        gh.checkoutFeature = async () => {};
        gh.appendAudit = async () => {};
        gh.isPromotionValidated = async () => true;

        fakeVscode.window.showWarningMessage = async (msg, ...actions) => {
            if (actions.includes("Stash & Continue")) { return "Stash & Continue"; }
            return actions[actions.length - 1] || "Yes, validate against QA"; // confirm dialogs
        };
        fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });

        await runPromotion({}, gh, "TEST-9", "qa", "validate", { refresh: () => {} });

        check("stashed before proceeding", events.includes("stashed"));
        check("checked back out to the original branch before restoring", events.indexOf("checkout:feature/TEST-9") !== -1 && events.indexOf("checkout:feature/TEST-9") < events.indexOf("restored"), JSON.stringify(events));
        check("stash restored once the operation finished", events.includes("restored"));
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
