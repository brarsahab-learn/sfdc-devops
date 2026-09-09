// Reproduces tonight's bug: a Bulk API 2.0 upsert job that completes with failures throws a
// top-level CLI error whose message is ALWAYS the generic "Job finished being processed but
// failed to process N records." — with the real per-record reasons (REQUIRED_FIELD_MISSING,
// DUPLICATE_VALUE, ...) available only via a follow-up `sf data bulk results` call that writes a
// CSV with an sf__Error column. parseImportResult must extract the jobId from that error so the
// engine can fetch the real reasons instead of showing only the opaque summary; parseCsv must
// correctly read that CSV, including sf__Error values that themselves contain commas.
const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const { parseImportResult, parseCsv } = require("../out/DataMigrationEngine.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

// ---- 1. The generic Bulk API 2.0 failure error carries a jobId we can follow up on ----
{
    const bulkFailureError = JSON.stringify({
        name: "SfError",
        message: "Job finished being processed but failed to process 93 records.",
        exitCode: 1,
        actions: [
            "Get the job results by running: \"sf data bulk results -o myOrg --job-id 750xx0000001ABC\".",
        ],
        data: { jobId: "750xx0000001ABC", state: "JobComplete" },
        context: "Upsert",
    });

    const result = parseImportResult(bulkFailureError);
    check("generic bulk failure still surfaces its message", result.failed.length === 1 && result.failed[0].error.includes("failed to process 93 records"));
    check("jobId is extracted from data.jobId for the follow-up fetch", result.jobId === "750xx0000001ABC", result.jobId);
}

// ---- 2. A non-bulk top-level error (no data.jobId) leaves jobId undefined ----
{
    const flagError = JSON.stringify({ name: "Error", message: "Missing required flag external-id", exitCode: 2 });
    const result = parseImportResult(flagError);
    check("a plain CLI error has no jobId", result.jobId === undefined);
}

// ---- 3. parseCsv reads the failed-records CSV, including a quoted sf__Error with a comma ----
{
    const csv = [
        'Name,External_Id__c,sf__Id,sf__Error',
        'Acme Insurance,Ref42,,"REQUIRED_FIELD_MISSING:Required fields are missing: [Product__c, Broker__c]:Product__c,Broker__c --"',
        'Beta Brokers,Ref43,,DUPLICATE_VALUE:duplicate value found: External_Id__c__c duplicates value on record with id: 001xx0000000001',
    ].join("\n");

    const rows = parseCsv(csv);
    check("parses both data rows", rows.length === 2, JSON.stringify(rows));
    check("quoted field with an embedded comma stays intact", rows[0].sf__Error.includes("[Product__c, Broker__c]"), rows[0].sf__Error);
    check("refId column (our externalId field) is preserved", rows[0].External_Id__c === "Ref42");
    check("second row's plain (unquoted) error is read correctly", rows[1].sf__Error.startsWith("DUPLICATE_VALUE"), rows[1].sf__Error);
}

console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
process.exit(allPass ? 0 : 1);
