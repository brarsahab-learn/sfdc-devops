"use strict";
// DeploymentEngine.ts — runs `sf project deploy start|validate` against a target org.
// Mirrors the shape of src/commands/coverageCheck.ts (same CLI-invocation pattern).
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkDeployConflicts = checkDeployConflicts;
exports.runDeploy = runDeploy;
const SfCli_1 = require("./SfCli");
const Log_1 = require("./Log");
/** `Utils.cls:42:7` when we have a real location, `Utils` (bare name) otherwise — used everywhere a component failure gets summarized so a real location reads like a compiler error a developer can jump straight to. */
function componentFailureLocator(f) {
    if (!f.fileName) {
        return f.name;
    }
    const line = Number.isFinite(f.lineNumber) ? `:${f.lineNumber}` : "";
    const col = line && Number.isFinite(f.columnNumber) ? `:${f.columnNumber}` : "";
    return `${f.fileName}${line}${col}`;
}
/**
 * Read-only lookup of exactly what `sf project deploy start --ignore-conflicts` (see below)
 * is about to silently overwrite — this extension always deploys treating the git-validated
 * promotion branch as authoritative, so org-side source tracking conflicts never block a real
 * deploy, but that shouldn't mean the user never finds out ANYTHING changed in the org since
 * it was last tracked. Best-effort: only orgs with source tracking enabled (sandboxes/scratch
 * orgs, not Prod) report anything here at all, and any parsing failure just returns an empty
 * list rather than blocking the actual deploy that follows.
 */
async function checkDeployConflicts(workspaceRoot, sourceRoot, sourceDirs, orgAlias) {
    const args = ["project", "deploy", "preview", "--target-org", orgAlias, "--json"];
    if (sourceDirs.length > 0) {
        for (const dir of sourceDirs) {
            args.push("--source-dir", dir);
        }
    }
    else {
        args.push("--source-dir", sourceRoot);
    }
    try {
        const r = await (0, SfCli_1.execSf)(args, { cwd: workspaceRoot, timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
        const parsed = JSON.parse(r.stdout);
        const raw = parsed?.result?.conflicts;
        if (!Array.isArray(raw)) {
            return [];
        }
        return raw.map((c) => ({
            fullName: String(c?.fullName ?? c?.fileName ?? "unknown"),
            type: String(c?.type ?? c?.componentType ?? ""),
            filePath: String(c?.filePath ?? c?.path ?? ""),
        }));
    }
    catch (e) {
        (0, Log_1.debugLog)(`deploy preview (conflict check) failed, skipping — ${e?.message ?? e}`);
        return [];
    }
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/** Turns one `project deploy report` poll into a short human status line — real numbers as they change, not just a static "Validating...". */
function formatProgress(result) {
    const status = String(result?.status ?? "Running");
    const cd = Number(result?.numberComponentsDeployed ?? 0);
    const ct = Number(result?.numberComponentsTotal ?? 0);
    const td = Number(result?.numberTestsCompleted ?? 0);
    const tt = Number(result?.numberTestsTotal ?? 0);
    const parts = [];
    if (ct > 0) {
        parts.push(`${cd}/${ct} component(s)`);
    }
    if (tt > 0) {
        parts.push(`${td}/${tt} test(s)`);
    }
    return parts.length > 0 ? `${status} — ${parts.join(", ")}` : `${status}...`;
}
const POLL_INTERVAL_MS = 3000;
/**
 * Runs a real (or check-only) Salesforce deploy. `sourceDirs` selects exactly which
 * files/components go — pass an empty array to deploy the whole `sourceRoot` ("ALL").
 * The working tree must already contain the content to deploy (the CLI deploys from
 * disk, not from a git ref) — callers are expected to have checked out the right branch
 * first (see GitHelper.createLocalBranchFrom).
 *
 * Kicks the deploy off async and polls `project deploy report` every few seconds rather
 * than blocking on a single `--wait` call — a real deploy/validate can run for minutes
 * with zero visible feedback otherwise; `onProgress` (if given) gets a live "N/M
 * components, N/M tests" status on every poll instead of a static "Deploying..." the
 * whole time.
 */
async function runDeploy(workspaceRoot, sourceRoot, sourceDirs, orgAlias, testLevel, timeoutSeconds, mode, specifiedTests, onProgress) {
    const base = { ran: false, success: false };
    if (!orgAlias) {
        return { ...base, error: "No org alias configured for this environment (sfDevops.environments[].orgAlias)." };
    }
    if (testLevel === "RunSpecifiedTests" && !(specifiedTests && specifiedTests.length > 0)) {
        return { ...base, error: "RunSpecifiedTests requires at least one test class — none were detected or selected." };
    }
    const args = ["project", "deploy", mode === "deploy" ? "start" : "validate"];
    if (sourceDirs.length > 0) {
        for (const dir of sourceDirs) {
            args.push("--source-dir", dir);
        }
    }
    else {
        args.push("--source-dir", sourceRoot);
    }
    args.push("--target-org", orgAlias);
    // "NoTestRun" is our internal sentinel meaning "omit the flag entirely" — the CLI
    // does not accept NoTestRun as a --test-level value; omitting the flag achieves the same.
    if (testLevel !== "NoTestRun") {
        args.push("--test-level", testLevel);
        if (testLevel === "RunSpecifiedTests") {
            for (const t of specifiedTests) {
                args.push("--tests", t);
            }
        }
    }
    // Only `deploy start` exposes this flag (not `deploy validate`, which never actually
    // touches the org). Without it, the CLI's own source-tracking conflict check can block a
    // real deploy outright — "N conflicts detected" — the moment the target org has anything
    // source-tracking sees as changed since its last retrieve. That check is for the
    // "org-as-source-of-truth" workflow `sf` was built around; this extension's whole model is
    // the opposite — the promotion branch (already validated) IS the source of truth, so
    // whatever the org's tracked state thinks changed should never be able to block it.
    if (mode === "deploy") {
        args.push("--ignore-conflicts");
    }
    args.push("--json", "--async");
    const verb = mode === "deploy" ? "Deploying" : "Validating";
    const scope = sourceDirs.length > 0 ? `${sourceDirs.length} file(s)` : "all files";
    const testsPart = testLevel === "RunSpecifiedTests" ? ` — tests: ${specifiedTests.join(", ")}` : "";
    const testLevelDisplay = testLevel === "NoTestRun" ? "NoTestRun (tests omitted)" : testLevel;
    (0, Log_1.revealLog)(`${verb} ${scope} to ${orgAlias} (${testLevelDisplay})${testsPart}`);
    // Real deploy only — see checkDeployConflicts' own comment for why this never blocks:
    // logged up front, before the deploy itself, so it's visible even though --ignore-conflicts
    // means the deploy below will proceed regardless of what this finds.
    let conflicts = [];
    if (mode === "deploy") {
        onProgress?.(`Checking for org-side conflicts on ${orgAlias}...`);
        conflicts = await checkDeployConflicts(workspaceRoot, sourceRoot, sourceDirs, orgAlias);
        if (conflicts.length > 0) {
            (0, Log_1.log)(`⚠ ${conflicts.length} org-side conflict(s) — the org has changed since it was last tracked, and this deploy will overwrite them (git is treated as authoritative, never the org):`);
            for (const c of conflicts) {
                (0, Log_1.log)(`  ${c.type ? `${c.type} ` : ""}${c.fullName}${c.filePath ? ` (${c.filePath})` : ""}`);
            }
        }
    }
    onProgress?.(`Starting — ${scope} to ${orgAlias}...`);
    let stdout = "";
    try {
        const r = await (0, SfCli_1.execSf)(args, {
            cwd: workspaceRoot,
            timeout: 120000, // starting the job async should be quick — this isn't the deploy itself
            maxBuffer: 20 * 1024 * 1024,
        });
        stdout = r.stdout;
    }
    catch (e) {
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
    // Async start can itself fail outright (bad args, auth) before ever producing a job id —
    // same bare top-level-error shape handled below for the final result, just checked early
    // here since there's nothing to poll for without an id.
    const jobId = parsed?.result?.id;
    if (!jobId) {
        (0, Log_1.debugLog)(`Raw CLI response (no job id):\n${JSON.stringify(parsed, null, 2)}`);
        const message = String(parsed?.message ?? parsed?.name ?? "The Salesforce CLI didn't return a job id to track.");
        (0, Log_1.log)(`Failed — ${message}`);
        return { ...base, error: message };
    }
    onProgress?.(formatProgress(parsed.result));
    const deadline = Date.now() + timeoutSeconds * 1000;
    const reportArgs = ["project", "deploy", "report", "--job-id", jobId, "--target-org", orgAlias, "--json"];
    let timedOut = false;
    while (true) {
        const done = Boolean(parsed?.result?.done) || ["Succeeded", "Failed", "Canceled", "SucceededPartial"].includes(String(parsed?.result?.status ?? ""));
        if (done) {
            break;
        }
        if (Date.now() >= deadline) {
            timedOut = true;
            break;
        }
        await sleep(POLL_INTERVAL_MS);
        try {
            const r = await (0, SfCli_1.execSf)(reportArgs, { cwd: workspaceRoot, timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
            parsed = JSON.parse(r.stdout);
        }
        catch (e) {
            // A single flaky poll shouldn't abandon an otherwise-healthy deploy — keep
            // polling until the deadline; only a poll that never once succeeds falls through
            // to the timeout/parse-failure paths below via the unchanged `parsed`.
            (0, Log_1.debugLog)(`Poll failed, retrying — ${e?.message ?? e}`);
            continue;
        }
        onProgress?.(formatProgress(parsed.result));
    }
    if (timedOut) {
        (0, Log_1.log)(`Timed out after ${timeoutSeconds}s waiting for job ${jobId} — check its status directly with "sf project deploy report --job-id ${jobId}".`);
        return { ...base, ran: true, deployId: jobId, error: `Timed out waiting for the deploy to finish (job ${jobId} may still be running in Salesforce — check it directly).` };
    }
    (0, Log_1.debugLog)(`Raw CLI response:\n${JSON.stringify(parsed, null, 2)}`);
    // The CLI's --json output has two entirely different shapes depending on WHERE it
    // failed: a deploy that ran and then failed produces {result: {status, details, ...}},
    // which everything below reads. But the command can also fail before ever producing a
    // deploy result at all — bad arguments, an auth/permission problem, a timeout wrapped
    // oddly — and THAT shape is a bare top-level error object ({status, name, message,
    // exitCode, ...}, no "result" key). `parsed?.result ?? {}` used to silently treat that
    // second shape as an empty (but present) deploy result, so none of the detail-extraction
    // below ever found anything to report — exactly what produced the bare "Deploy did not
    // succeed... no further detail" the audit log and error toast were showing, even though
    // the real reason was sitting right there in parsed.message/parsed.name.
    const topLevelError = !parsed?.result
        ? String(parsed?.message ?? parsed?.name ?? "") || undefined
        : undefined;
    const result = parsed?.result ?? {};
    const status = String(result?.status ?? "");
    const isPartial = status === "SucceededPartial";
    const success = status === "Succeeded" || isPartial || result?.success === true;
    (0, Log_1.debugLog)(`Job ${result?.id ?? "(no id)"} — status: ${status || "(unknown)"}, success: ${success}`);
    const failures = (result?.details?.componentFailures ?? [])
        .map((f) => {
        const lineNumber = Number(f?.lineNumber);
        const columnNumber = Number(f?.columnNumber);
        return {
            type: String(f?.componentType ?? f?.type ?? ""),
            name: String(f?.fullName ?? f?.name ?? ""),
            problem: String(f?.problem ?? f?.message ?? "Unknown error"),
            fileName: f?.fileName ? String(f.fileName) : undefined,
            lineNumber: Number.isFinite(lineNumber) ? lineNumber : undefined,
            columnNumber: Number.isFinite(columnNumber) ? columnNumber : undefined,
        };
    });
    const numberComponentsDeployed = Number(result?.numberComponentsDeployed ?? result?.details?.componentSuccesses?.length ?? 0);
    // The underlying Metadata API RunTestsResult names this `numFailures`, not
    // `numberTestsFailed` — reading the wrong field silently produced 0 for every real test
    // failure once results started coming from `project deploy report` (this engine polls
    // that now instead of one blocking `deploy start --wait`), which reports this same
    // RunTestsResult shape but was never actually checked against real output before. That
    // sent every pure-test-failure straight to the generic "no further detail" fallback
    // below even though the CLI had real failure messages the whole time.
    const testFailures = (result?.details?.runTestResult?.failures ?? []).map((f) => ({
        name: String(f?.name ?? f?.className ?? ""),
        methodName: String(f?.methodName ?? ""),
        message: String(f?.message ?? "Unknown test failure"),
    }));
    const testsFailed = Number(result?.details?.runTestResult?.numFailures ?? result?.details?.runTestResult?.numberTestsFailed ?? testFailures.length ?? 0);
    const testsRun = Number(result?.details?.runTestResult?.numTestsRun ?? 0);
    // What actually gets shown on screen (outcome banner, error toast) and written to the
    // audit log both read this same `error` string — it used to go blank whenever there
    // WERE real component failures (the generic "Deploy did not succeed." fallback only
    // fired for a truly unknown failure shape, but the caller's own "not success → show
    // result.error" logic had nothing to show when this was left undefined), so the actual
    // reason sat unread in the log channel instead of reaching either surface. Always build
    // a real message out of whatever detail the CLI response actually gave us.
    const errorMessage = success ? undefined : buildDeployErrorMessage(result, failures, testsFailed, testsRun, status, topLevelError, testFailures);
    if (success) {
        const testsPart = testsRun > 0 ? `, ${testsRun - testsFailed}/${testsRun} test(s) passed` : "";
        const partialNote = isPartial ? " (partial — some components may not have deployed; check the Output Channel for details)" : "";
        (0, Log_1.log)(`${mode === "deploy" ? "Deployed" : "Validated"} — ${numberComponentsDeployed} component(s)${testsPart}${partialNote}.`);
    }
    else if (topLevelError) {
        (0, Log_1.log)(`Failed — ${topLevelError}`);
    }
    else if (failures.length > 0) {
        (0, Log_1.log)(`Failed — ${failures.length} component error(s):`);
        for (const f of failures.slice(0, 10)) {
            (0, Log_1.log)(`  ${componentFailureLocator(f)} — ${f.problem}`);
        }
        if (failures.length > 10) {
            (0, Log_1.log)(`  ...and ${failures.length - 10} more.`);
        }
    }
    else if (testsFailed > 0) {
        (0, Log_1.log)(`Failed — ${testsFailed} test(s) failed:`);
        for (const f of testFailures.slice(0, 10)) {
            (0, Log_1.log)(`  ${f.name}.${f.methodName} — ${f.message}`);
        }
        if (testFailures.length > 10) {
            (0, Log_1.log)(`  ...and ${testFailures.length - 10} more.`);
        }
    }
    else {
        (0, Log_1.log)(`Failed — ${errorMessage}`);
    }
    return {
        ran: true,
        success,
        partial: isPartial || undefined,
        deployId: result?.id,
        numberComponentsDeployed,
        numberComponentErrors: Number(result?.numberComponentErrors ?? failures.length ?? 0),
        componentFailures: failures,
        testsFailed,
        testFailures,
        conflicts,
        error: errorMessage,
    };
}
/** Turns whatever the CLI response actually gave us into a real, specific error string — never the bare "Deploy did not succeed." unless there's truly nothing else to report. */
function buildDeployErrorMessage(result, failures, testsFailed, testsRun, status, topLevelError, testFailures = []) {
    if (topLevelError) {
        return topLevelError;
    }
    if (result?.errorMessage) {
        return String(result.errorMessage);
    }
    if (failures.length > 0) {
        const shown = failures.slice(0, 3).map(f => `${componentFailureLocator(f)}: ${f.problem}`).join("; ");
        const more = failures.length > 3 ? ` (+${failures.length - 3} more — see the audit trail)` : "";
        return `${failures.length} component error(s) — ${shown}${more}`;
    }
    if (testsFailed > 0) {
        const shown = testFailures.slice(0, 3).map(f => `${f.name}.${f.methodName}: ${f.message}`).join("; ");
        const more = testFailures.length > 3 ? ` (+${testFailures.length - 3} more — see the audit trail)` : "";
        return shown ? `${testsFailed} of ${testsRun} test(s) failed — ${shown}${more}` : `${testsFailed} of ${testsRun} test(s) failed.`;
    }
    return `Deploy did not succeed${status ? ` (status: ${status})` : ""} — the Salesforce CLI gave no further detail.`;
}
function friendlyCliError(e) {
    const msg = String(e?.message ?? e);
    if (/ENOENT/.test(msg)) {
        return "Salesforce CLI (sf) was not found on PATH. Install it and re-try.";
    }
    if (/No default environment|No target org|not authorized|expired|INVALID_LOGIN/i.test(msg)) {
        return "No authenticated org found for this alias. Run `sf org login web --alias <alias>` and re-try.";
    }
    return msg.split("\n")[0];
}
//# sourceMappingURL=DeploymentEngine.js.map