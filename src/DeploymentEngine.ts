// DeploymentEngine.ts — runs `sf project deploy start|validate` against a target org.
// Mirrors the shape of src/commands/coverageCheck.ts (same CLI-invocation pattern).

import { execSf } from "./SfCli";
import { log, revealLog } from "./Log";

export interface ComponentFailure {
    type:    string;
    name:    string;
    problem: string;
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
    mode:          DeployMode
): Promise<DeployResult> {
    const base: DeployResult = { ran: false, success: false };

    if (!orgAlias) {
        return { ...base, error: "No org alias configured for this environment (sfDevops.environments[].orgAlias)." };
    }

    const args = ["project", "deploy", mode === "deploy" ? "start" : "validate"];
    if (sourceDirs.length > 0) {
        for (const dir of sourceDirs) { args.push("--source-dir", dir); }
    } else {
        args.push("--source-dir", sourceRoot);
    }
    args.push("--target-org", orgAlias, "--test-level", testLevel);
    args.push("--json", "--wait", String(Math.max(1, Math.round(timeoutSeconds / 60))));

    const verb = mode === "deploy" ? "Deploying" : "Validating";
    const scope = sourceDirs.length > 0 ? `${sourceDirs.length} file(s)` : "all files";
    revealLog(`${verb} ${scope} to ${orgAlias} (${testLevel})`);

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

    const result = parsed?.result ?? {};
    const status = String(result?.status ?? "");
    const success = status === "Succeeded" || result?.success === true;

    const failures: ComponentFailure[] = (result?.details?.componentFailures ?? [])
        .map((f: any) => ({
            type:    String(f?.componentType ?? f?.type ?? ""),
            name:    String(f?.fullName ?? f?.name ?? ""),
            problem: String(f?.problem ?? f?.message ?? "Unknown error"),
        }));

    const numberComponentsDeployed = Number(result?.numberComponentsDeployed ?? result?.details?.componentSuccesses?.length ?? 0);
    const testsFailed = Number(result?.details?.runTestResult?.numberTestsFailed ?? 0);
    const testsRun = Number(result?.details?.runTestResult?.numTestsRun ?? 0);

    if (success) {
        const testsPart = testsRun > 0 ? `, ${testsRun - testsFailed}/${testsRun} test(s) passed` : "";
        log(`${mode === "deploy" ? "Deployed" : "Validated"} — ${numberComponentsDeployed} component(s)${testsPart}.`);
    } else if (failures.length > 0) {
        log(`Failed — ${failures.length} component error(s):`);
        for (const f of failures.slice(0, 10)) { log(`  ${f.name}: ${f.problem}`); }
        if (failures.length > 10) { log(`  ...and ${failures.length - 10} more.`); }
    } else if (testsFailed > 0) {
        log(`Failed — ${testsFailed} test(s) failed.`);
    } else {
        log(`Failed — ${result?.errorMessage || "deploy did not succeed."}`);
    }

    return {
        ran: true,
        success,
        deployId: result?.id,
        numberComponentsDeployed,
        numberComponentErrors: Number(result?.numberComponentErrors ?? failures.length ?? 0),
        componentFailures: failures,
        testsFailed,
        error: success ? undefined : (result?.errorMessage || (failures.length ? undefined : "Deploy did not succeed.")),
    };
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
