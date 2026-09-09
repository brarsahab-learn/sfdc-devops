"use strict";
// coverageCheck.ts — runs Apex tests in whichever org the story's changes are currently
// sitting in and checks per-class coverage. Used by the Code Coverage panel to enforce
// the one-time ≥ threshold gate before the story can be promoted into the gated environment.
Object.defineProperty(exports, "__esModule", { value: true });
exports.runApexCoverage = runApexCoverage;
exports.coverageSettings = coverageSettings;
exports.findRelatedTestClasses = findRelatedTestClasses;
const SfCli_1 = require("../SfCli");
const Log_1 = require("../Log");
const config_1 = require("../config");
/**
 * Runs `sf apex run test` for the given test classes against the org the story's changes
 * are currently in (see getCoverageSourceOrg — not always "dev": if the coverage gate sits
 * further down the pipeline, this is that prior stage's org) and returns the coverage of
 * the feature branch's Apex classes.
 */
async function runApexCoverage(workspaceRoot, featureClasses, testClasses, threshold, targetOrgAlias) {
    const base = {
        ran: false, passed: false, threshold, perClass: [], testsFailed: 0,
    };
    if (featureClasses.length === 0) {
        // No Apex to cover → gate is satisfied.
        return { ...base, ran: true, passed: true };
    }
    if (testClasses.length === 0) {
        return { ...base, error: "Enter at least one test class name to run." };
    }
    const timeoutSeconds = (0, config_1.getCoverageTimeoutSeconds)();
    const args = ["apex", "run", "test"];
    for (const t of testClasses) {
        args.push("--tests", t);
    }
    args.push("--code-coverage", "--json", "--wait", String(Math.max(1, Math.round(timeoutSeconds / 60))));
    if (targetOrgAlias) {
        args.push("--target-org", targetOrgAlias);
    }
    (0, Log_1.revealLog)(`Running ${testClasses.length} Apex test class(es) against ${targetOrgAlias || "the default org"}`);
    let stdout = "";
    try {
        const r = await (0, SfCli_1.execSf)(args, {
            cwd: workspaceRoot,
            timeout: timeoutSeconds * 1000, // tests can take minutes; configurable via sfDevops.coverageTimeoutSeconds
            maxBuffer: 20 * 1024 * 1024,
        });
        stdout = r.stdout;
    }
    catch (e) {
        // sf exits non-zero on test failures but still emits JSON on stdout.
        stdout = e?.stdout ?? "";
        if (!stdout) {
            const message = friendlyCliError(e);
            (0, Log_1.log)(`Failed — ${message}`);
            return { ...base, error: message };
        }
    }
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        (0, Log_1.log)("Failed — could not read the Salesforce CLI response.");
        return { ...base, error: "Could not parse the Salesforce CLI response." };
    }
    (0, Log_1.debugLog)(`Raw CLI response:\n${JSON.stringify(parsed, null, 2)}`);
    const result = parsed?.result ?? {};
    const covArr = result?.coverage?.coverage ?? [];
    const failing = Number(result?.summary?.failing ?? 0);
    (0, Log_1.debugLog)(`Test run ${result?.summary?.testRunId ?? "(no id)"} — ${result?.summary?.passing ?? 0} passing, ${failing} failing`);
    const covByName = new Map();
    for (const c of covArr) {
        if (c?.name) {
            covByName.set(String(c.name), Number(c.coveredPercent ?? 0));
        }
    }
    const perClass = featureClasses.map((name) => {
        const percent = covByName.has(name) ? Math.round(covByName.get(name)) : 0;
        return { name, percent, pass: percent >= threshold };
    });
    const passed = failing === 0 && perClass.every((c) => c.pass);
    if (passed) {
        (0, Log_1.log)(`Coverage check passed — ${perClass.length}/${perClass.length} class(es) ≥ ${threshold}%.`);
    }
    else {
        if (failing > 0) {
            (0, Log_1.log)(`Coverage check failed — ${failing} test(s) failed.`);
        }
        const below = perClass.filter(c => !c.pass);
        if (below.length > 0) {
            (0, Log_1.log)(`${below.length} class(es) below ${threshold}%:`);
            for (const c of below) {
                (0, Log_1.log)(`  ${c.name}: ${c.percent}%`);
            }
        }
    }
    return { ran: true, passed, threshold, perClass, testsFailed: failing };
}
function friendlyCliError(e) {
    const msg = String(e?.message ?? e);
    if (/ENOENT/.test(msg)) {
        return "Salesforce CLI (sf) was not found on PATH. Install it and re-try.";
    }
    if (/No default environment|No target org|not authorized|expired/i.test(msg)) {
        return "No authenticated org found for the configured alias — authenticate it (see the Setup Check panel) or fix sfDevops.devOrgAlias / environments[].orgAlias.";
    }
    return msg.split("\n")[0];
}
/** Reads the coverage threshold + which org tests should actually run against. */
function coverageSettings() {
    const { alias, label } = (0, config_1.getCoverageSourceOrg)();
    return {
        threshold: (0, config_1.getCoverageThreshold)(),
        sourceOrgAlias: alias,
        sourceOrgLabel: label,
    };
}
/**
 * Guesses each feature class's test class by the naming convention Salesforce tooling
 * (including VS Code's own Salesforce extension) already relies on — no dependency graph,
 * no Tooling API query, just a filename match against what's actually in the repo. This is
 * a best-effort suggestion, not a guarantee a class is actually tested by it.
 */
function findRelatedTestClasses(featureClasses, apexClassBasenames) {
    const found = [];
    const missing = [];
    for (const name of featureClasses) {
        const candidates = [`${name}Test`, `${name}_Test`, `Test${name}`, `${name}Tests`];
        const match = candidates.find(c => apexClassBasenames.has(c));
        if (match) {
            found.push(match);
        }
        else {
            missing.push(name);
        }
    }
    return { found: Array.from(new Set(found)), missing };
}
//# sourceMappingURL=coverageCheck.js.map