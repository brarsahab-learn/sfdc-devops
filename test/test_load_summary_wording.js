// Reproduces the user's complaint: the log showed "Team__c: 0 created" for objects that had
// actually loaded successfully in an earlier run — every record was skipped this run because
// tracking already marked it "created", or matched via upsert and updated rather than freshly
// inserted. "0 created" reads exactly like a failure. summarizeObjectResult must say what
// actually happened instead.
const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const { summarizeObjectResult } = require("../out/DataMigrationEngine.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

// Team__c re-run: every record was already tracked "created" from a prior run, so nothing was
// even sent to Salesforce this time.
check(
    "re-run where everything was already done says so, not '0 created'",
    summarizeObjectResult({ created: 0, updated: 0, alreadyDone: 32, total: 32 }) === "32 already up to date",
    summarizeObjectResult({ created: 0, updated: 0, alreadyDone: 32, total: 32 }),
);

// Broker__c upsert re-run: records existed in the org and were matched+updated via ExternalId,
// not freshly inserted.
check(
    "records upserted as updates (not new inserts) are reported as 'updated'",
    summarizeObjectResult({ created: 0, updated: 1240, alreadyDone: 0, total: 1240 }) === "1240 updated",
    summarizeObjectResult({ created: 0, updated: 1240, alreadyDone: 0, total: 1240 }),
);

// A genuinely fresh insert-mode load.
check(
    "a first-time insert still reads as 'created'",
    summarizeObjectResult({ created: 93, updated: 0, alreadyDone: 0, total: 93 }) === "93 created",
);

// Mixed batch: some new, some pre-existing-and-updated, some already done from a prior partial run.
check(
    "a mixed run reports all three buckets",
    summarizeObjectResult({ created: 10, updated: 5, alreadyDone: 3, total: 18 }) === "10 created, 5 updated, 3 already up to date",
    summarizeObjectResult({ created: 10, updated: 5, alreadyDone: 3, total: 18 }),
);

// A genuine total failure (0 processed, nothing succeeded, but records existed to try) —
// distinguished from "0 created" on an object with no seed data at all.
check(
    "zero success out of a nonzero total reads as '0 processed', not a bare '0 created'",
    summarizeObjectResult({ created: 0, updated: 0, alreadyDone: 0, total: 190 }) === "0 processed",
);

console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
process.exit(allPass ? 0 : 1);
