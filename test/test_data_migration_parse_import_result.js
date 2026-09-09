const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const { parseImportResult } = require("../out/DataMigrationEngine.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

// Reproduces the actual bug: `sf data upsert bulk --external-id-field <x>` is not a real flag
// (the CLI flag is `--external-id`/`-i`), so the CLI rejects the command before ever touching
// the org and prints a top-level oclif error object — {name, message, exitCode, ...} — with no
// `result`/`result.results` array. parseImportResult used to treat this shape as "zero items"
// and silently return everything empty, so callers reported "N failed in batch" with no error
// detail at all.
{
    const cliError = JSON.stringify({
        name: "Error",
        message: "Missing required flag external-id\nSee more help with --help",
        exitCode: 2,
        context: "Upsert",
        status: 2,
        commandName: "Upsert",
    });

    const result = parseImportResult(cliError);
    check("top-level CLI error yields no created records", result.created.length === 0);
    check(
        "top-level CLI error is surfaced in failed[], not silently swallowed",
        result.failed.length === 1 && result.failed[0].error.includes("Missing required flag external-id"),
        JSON.stringify(result.failed),
    );
}

// Normal import-tree success/failure item shape still works.
{
    const treeResult = JSON.stringify({
        status: 0,
        result: {
            results: [
                { referenceId: "Ref1", id: "001xx0000000001AAA" },
                { referenceId: "Ref2", errors: [{ message: "REQUIRED_FIELD_MISSING: Name" }] },
            ],
        },
    });

    const result = parseImportResult(treeResult);
    check("import tree: successful record recorded", result.createdByRef.get("Ref1") === "001xx0000000001AAA");
    check(
        "import tree: failed record keeps its real error message",
        result.failed.length === 1 && result.failed[0].error.includes("REQUIRED_FIELD_MISSING"),
        JSON.stringify(result.failed),
    );
}

console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
process.exit(allPass ? 0 : 1);
