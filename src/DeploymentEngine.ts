// DeploymentEngine.ts — runs `sf project deploy start|validate` against a target org.
// Mirrors the shape of src/commands/coverageCheck.ts (same CLI-invocation pattern).

import { execSf } from "./SfCli";
import { log, revealLog, debugLog } from "./Log";

export interface ComponentFailure {
    type:        string;
    name:        string;
    problem:     string;
    /** Only present for failures the CLI can pin to an exact source location — Apex/trigger compile errors, mainly. Absent for e.g. a missing-field error on a Custom Object. */
    fileName?:    string;
    lineNumber?:  number;
    columnNumber?: number;
}

/** `Utils.cls:42:7` when we have a real location, `Utils` (bare name) otherwise — used everywhere a component failure gets summarized so a real location reads like a compiler error a developer can jump straight to. */
function componentFailureLocator(f: ComponentFailure): string {
    if (!f.fileName) { return f.name; }
    const line = Number.isFinite(f.lineNumber) ? `:${f.lineNumber}` : "";
    const col  = line && Number.isFinite(f.columnNumber) ? `:${f.columnNumber}` : "";
    return `${f.fileName}${line}${col}`;
}

export interface DeployResult {
    ran:                       boolean;
    success:                   boolean;
    deployId?:                 string;
    numberComponentsDeployed?: number;
    numberComponentErrors?:    number;
    componentFailures?:        ComponentFailure[];
    testsFailed?:              number;
    error?:                    string;
}

export type DeployMode = "deploy" | "validate";

/**
 * Runs a real (or check-only) Salesforce deploy. `sourceDirs` selects exactly which
 * files/components go — pass an empty array to deploy the whole `sourceRoot` ("ALL").
 * The working tree must already contain the content to deploy (the CLI deploys from
 * disk, not from a git ref) — callers are expected to have checked out the right branch
 * first (see GitHelper.createLocalBranchFrom).
 */
export async function runDeploy(
    workspaceRoot: string,
    sourceRoot:    string,
    sourceDirs:    string[],
    orgAlias:      string,
    testLevel:     string,
    timeoutSeconds: number,
    mode:          DeployMode,
    specifiedTests?: string[]
): Promise<DeployResult> {
    const base: DeployResult = { ran: false, success: false };

    if (!orgAlias) {
        return { ...base, error: "No org alias configured for this environment (sfDevops.environments[].orgAlias)." };
    }
    if (testLevel === "RunSpecifiedTests" && !(specifiedTests && specifiedTests.length > 0)) {
        return { ...base, error: "RunSpecifiedTests requires at least one test class — none were detected or selected." };
    }

    const args = ["project", "deploy", mode === "deploy" ? "start" : "validate"];
    if (sourceDirs.length > 0) {
        for (const dir of sourceDirs) { args.push("--source-dir", dir); }
    } else {
        args.push("--source-dir", sourceRoot);
    }
    args.push("--target-org", orgAlias, "--test-level", testLevel);
    if (testLevel === "RunSpecifiedTests") {
        for (const t of specifiedTests!) { args.push("--tests", t); }
    }
    args.push("--json", "--wait", String(Math.max(1, Math.round(timeoutSeconds / 60))));

    const verb = mode === "deploy" ? "Deploying" : "Validating";
    const scope = sourceDirs.length > 0 ? `${sourceDirs.length} file(s)` : "all files";
    const testsPart = testLevel === "RunSpecifiedTests" ? ` — tests: ${specifiedTests!.join(", ")}` : "";
    revealLog(`${verb} ${scope} to ${orgAlias} (${testLevel})${testsPart}`);

    let stdout = "";
    try {
        const r = await execSf(args, {
            cwd: workspaceRoot,
            timeout: timeoutSeconds * 1000,
            maxBuffer: 20 * 1024 * 1024,
        });
        stdout = r.stdout;
    } catch (e: any) {
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

    const result = parsed?.result ?? {};
    const status = String(result?.status ?? "");
    const success = status === "Succeeded" || result?.success === true;
    debugLog(`Job ${result?.id ?? "(no id)"} — status: ${status || "(unknown)"}, success: ${success}`);

    const failures: ComponentFailure[] = (result?.details?.componentFailures ?? [])
        .map((f: any) => {
            const lineNumber   = Number(f?.lineNumber);
            const columnNumber = Number(f?.columnNumber);
            return {
                type:    String(f?.componentType ?? f?.type ?? ""),
                name:    String(f?.fullName ?? f?.name ?? ""),
                problem: String(f?.problem ?? f?.message ?? "Unknown error"),
                fileName:     f?.fileName ? String(f.fileName) : undefined,
                lineNumber:   Number.isFinite(lineNumber) ? lineNumber : undefined,
                columnNumber: Number.isFinite(columnNumber) ? columnNumber : undefined,
            };
        });

    const numberComponentsDeployed = Number(result?.numberComponentsDeployed ?? result?.details?.componentSuccesses?.length ?? 0);
    const testsFailed = Number(result?.details?.runTestResult?.numberTestsFailed ?? 0);
    const testsRun = Number(result?.details?.runTestResult?.numTestsRun ?? 0);

    // What actually gets shown on screen (outcome banner, error toast) and written to the
    // audit log both read this same `error` string — it used to go blank whenever there
    // WERE real component failures (the generic "Deploy did not succeed." fallback only
    // fired for a truly unknown failure shape, but the caller's own "not success → show
    // result.error" logic had nothing to show when this was left undefined), so the actual
    // reason sat unread in the log channel instead of reaching either surface. Always build
    // a real message out of whatever detail the CLI response actually gave us.
    const errorMessage = success ? undefined : buildDeployErrorMessage(result, failures, testsFailed, testsRun, status);

    if (success) {
        const testsPart = testsRun > 0 ? `, ${testsRun - testsFailed}/${testsRun} test(s) passed` : "";
        log(`${mode === "deploy" ? "Deployed" : "Validated"} — ${numberComponentsDeployed} component(s)${testsPart}.`);
    } else if (failures.length > 0) {
        log(`Failed — ${failures.length} component error(s):`);
        for (const f of failures.slice(0, 10)) { log(`  ${componentFailureLocator(f)} — ${f.problem}`); }
        if (failures.length > 10) { log(`  ...and ${failures.length - 10} more.`); }
    } else if (testsFailed > 0) {
        log(`Failed — ${testsFailed} test(s) failed.`);
    } else {
        log(`Failed — ${errorMessage}`);
    }

    return {
        ran: true,
        success,
        deployId: result?.id,
        numberComponentsDeployed,
        numberComponentErrors: Number(result?.numberComponentErrors ?? failures.length ?? 0),
        componentFailures: failures,
        testsFailed,
        error: errorMessage,
    };
}

/** Turns whatever the CLI response actually gave us into a real, specific error string — never the bare "Deploy did not succeed." unless there's truly nothing else to report. */
function buildDeployErrorMessage(
    result: any,
    failures: ComponentFailure[],
    testsFailed: number,
    testsRun: number,
    status: string
): string {
    if (result?.errorMessage) { return String(result.errorMessage); }
    if (failures.length > 0) {
        const shown = failures.slice(0, 3).map(f => `${componentFailureLocator(f)}: ${f.problem}`).join("; ");
        const more = failures.length > 3 ? ` (+${failures.length - 3} more — see the audit trail)` : "";
        return `${failures.length} component error(s) — ${shown}${more}`;
    }
    if (testsFailed > 0) {
        return `${testsFailed} of ${testsRun} test(s) failed.`;
    }
    return `Deploy did not succeed${status ? ` (status: ${status})` : ""} — the Salesforce CLI gave no further detail.`;
}

function friendlyCliError(e: any): string {
    const msg = String(e?.message ?? e);
    if (/ENOENT/.test(msg)) {
        return "Salesforce CLI (sf) was not found on PATH. Install it and re-try.";
    }
    if (/No default environment|No target org|not authorized|expired|INVALID_LOGIN/i.test(msg)) {
        return "No authenticated org found for this alias. Run `sf org login web --alias <alias>` and re-try.";
    }
    return msg.split("\n")[0];
}
