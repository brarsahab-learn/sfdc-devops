// coverageCheck.ts — runs Apex tests in whichever org the story's changes are currently
// sitting in and checks per-class coverage. Used by the Code Coverage panel to enforce
// the one-time ≥ threshold gate before the story can be promoted into the gated environment.

import { execSf } from "../SfCli";
import { log, revealLog, debugLog } from "../Log";
import { getCoverageThreshold, getCoverageSourceOrg, getCoverageTimeoutSeconds } from "../config";

export interface ClassCoverage {
    name:    string;
    percent: number;
    pass:    boolean;
}

export interface CoverageResult {
    ran:       boolean;
    passed:    boolean;
    threshold: number;
    perClass:  ClassCoverage[];
    testsFailed: number;
    error?:    string;
}

/**
 * Runs `sf apex run test` for the given test classes against the org the story's changes
 * are currently in (see getCoverageSourceOrg — not always "dev": if the coverage gate sits
 * further down the pipeline, this is that prior stage's org) and returns the coverage of
 * the feature branch's Apex classes.
 */
export async function runApexCoverage(
    workspaceRoot:   string,
    featureClasses:  string[],
    testClasses:     string[],
    threshold:       number,
    targetOrgAlias:  string
): Promise<CoverageResult> {
    const base: CoverageResult = {
        ran: false, passed: false, threshold, perClass: [], testsFailed: 0,
    };

    if (featureClasses.length === 0) {
        // No Apex to cover → gate is satisfied.
        return { ...base, ran: true, passed: true };
    }
    if (testClasses.length === 0) {
        return { ...base, error: "Enter at least one test class name to run." };
    }

    const timeoutSeconds = getCoverageTimeoutSeconds();
    const args = ["apex", "run", "test"];
    for (const t of testClasses) { args.push("--tests", t); }
    args.push("--code-coverage", "--json", "--wait", String(Math.max(1, Math.round(timeoutSeconds / 60))));
    if (targetOrgAlias) { args.push("--target-org", targetOrgAlias); }

    revealLog(`Running ${testClasses.length} Apex test class(es) against ${targetOrgAlias || "the default org"}`);

    let stdout = "";
    try {
        const r = await execSf(args, {
            cwd: workspaceRoot,
            timeout: timeoutSeconds * 1000,   // tests can take minutes; configurable via sfDevops.coverageTimeoutSeconds
            maxBuffer: 20 * 1024 * 1024,
        });
        stdout = r.stdout;
    } catch (e: any) {
        // sf exits non-zero on test failures but still emits JSON on stdout.
        stdout = e?.stdout ?? "";
        if (!stdout) {
            const message = friendlyCliError(e);
            log(`Failed — ${message}`);
            return { ...base, error: message };
        }
    }

    let parsed: any;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        log("Failed — could not read the Salesforce CLI response.");
        return { ...base, error: "Could not parse the Salesforce CLI response." };
    }

    debugLog(`Raw CLI response:\n${JSON.stringify(parsed, null, 2)}`);

    const result   = parsed?.result ?? {};
    const covArr    = result?.coverage?.coverage ?? [];
    const failing   = Number(result?.summary?.failing ?? 0);
    debugLog(`Test run ${result?.summary?.testRunId ?? "(no id)"} — ${result?.summary?.passing ?? 0} passing, ${failing} failing`);

    const covByName = new Map<string, number>();
    for (const c of covArr) {
        if (c?.name) { covByName.set(String(c.name), Number(c.coveredPercent ?? 0)); }
    }

    const perClass: ClassCoverage[] = featureClasses.map((name) => {
        const percent = covByName.has(name) ? Math.round(covByName.get(name)!) : 0;
        return { name, percent, pass: percent >= threshold };
    });

    const passed = failing === 0 && perClass.every((c) => c.pass);

    if (passed) {
        log(`Coverage check passed — ${perClass.length}/${perClass.length} class(es) ≥ ${threshold}%.`);
    } else {
        if (failing > 0) { log(`Coverage check failed — ${failing} test(s) failed.`); }
        const below = perClass.filter(c => !c.pass);
        if (below.length > 0) {
            log(`${below.length} class(es) below ${threshold}%:`);
            for (const c of below) { log(`  ${c.name}: ${c.percent}%`); }
        }
    }

    return { ran: true, passed, threshold, perClass, testsFailed: failing };
}

function friendlyCliError(e: any): string {
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
export function coverageSettings(): { threshold: number; sourceOrgAlias: string; sourceOrgLabel: string } {
    const { alias, label } = getCoverageSourceOrg();
    return {
        threshold:      getCoverageThreshold(),
        sourceOrgAlias: alias,
        sourceOrgLabel: label,
    };
}

export interface RelatedTestClasses {
    /** Test class found for a feature class, by naming convention (<Class>Test, <Class>_Test, Test<Class>, <Class>Tests). */
    found:   string[];
    /** Feature classes with no matching test class found — still need one entered manually. */
    missing: string[];
}

/**
 * Guesses each feature class's test class by the naming convention Salesforce tooling
 * (including VS Code's own Salesforce extension) already relies on — no dependency graph,
 * no Tooling API query, just a filename match against what's actually in the repo. This is
 * a best-effort suggestion, not a guarantee a class is actually tested by it.
 */
export function findRelatedTestClasses(featureClasses: string[], apexClassBasenames: Set<string>): RelatedTestClasses {
    const found: string[] = [];
    const missing: string[] = [];

    for (const name of featureClasses) {
        const candidates = [`${name}Test`, `${name}_Test`, `Test${name}`, `${name}Tests`];
        const match = candidates.find(c => apexClassBasenames.has(c));
        if (match) { found.push(match); } else { missing.push(name); }
    }

    return { found: Array.from(new Set(found)), missing };
}
