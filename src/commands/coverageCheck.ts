// coverageCheck.ts — runs Apex tests in the dev (source) org and checks per-class coverage.
// Used by the Code Coverage panel to enforce the one-time ≥ threshold gate before QA.

import { execFile } from "child_process";
import { promisify } from "util";
import { getCoverageThreshold, getDevOrgAlias, getCoverageTimeoutSeconds } from "../config";

const execFileAsync = promisify(execFile);

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
 * Runs `sf apex run test` for the given test classes against the dev org and returns
 * the coverage of the feature branch's Apex classes.
 */
export async function runApexCoverage(
    workspaceRoot:  string,
    featureClasses: string[],
    testClasses:    string[],
    threshold:      number,
    devOrgAlias:    string
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
    if (devOrgAlias) { args.push("--target-org", devOrgAlias); }

    let stdout = "";
    try {
        const r = await execFileAsync("sf", args, {
            cwd: workspaceRoot,
            timeout: timeoutSeconds * 1000,   // tests can take minutes; configurable via sfDevops.coverageTimeoutSeconds
            maxBuffer: 20 * 1024 * 1024,
            shell: true,                  // resolve sf / sf.cmd via PATH
        });
        stdout = r.stdout;
    } catch (e: any) {
        // sf exits non-zero on test failures but still emits JSON on stdout.
        stdout = e?.stdout ?? "";
        if (!stdout) {
            return { ...base, error: friendlyCliError(e) };
        }
    }

    let parsed: any;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return { ...base, error: "Could not parse the Salesforce CLI response." };
    }

    const result   = parsed?.result ?? {};
    const covArr    = result?.coverage?.coverage ?? [];
    const failing   = Number(result?.summary?.failing ?? 0);

    const covByName = new Map<string, number>();
    for (const c of covArr) {
        if (c?.name) { covByName.set(String(c.name), Number(c.coveredPercent ?? 0)); }
    }

    const perClass: ClassCoverage[] = featureClasses.map((name) => {
        const percent = covByName.has(name) ? Math.round(covByName.get(name)!) : 0;
        return { name, percent, pass: percent >= threshold };
    });

    const passed = failing === 0 && perClass.every((c) => c.pass);

    return { ran: true, passed, threshold, perClass, testsFailed: failing };
}

function friendlyCliError(e: any): string {
    const msg = String(e?.message ?? e);
    if (/ENOENT/.test(msg)) {
        return "Salesforce CLI (sf) was not found on PATH. Install it and re-try.";
    }
    if (/No default environment|No target org|not authorized|expired/i.test(msg)) {
        return "No authenticated dev org found. Authenticate the dev org (or set sfDevops.devOrgAlias).";
    }
    return msg.split("\n")[0];
}

/** Reads the coverage threshold + dev org alias from settings. */
export function coverageSettings(): { threshold: number; devOrgAlias: string } {
    return {
        threshold:   getCoverageThreshold(),
        devOrgAlias: getDevOrgAlias(),
    };
}
