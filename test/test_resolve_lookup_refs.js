// Reproduces the real bug from the user's failing load: Product__c and Product_Group__c are
// pulled with SEPARATE, isolated `sf data export tree` calls (one per object), so that command's
// own cross-file @refId linking never has visibility across objects — every lookup field (e.g.
// Product__c.Product_Group__c) is left holding the SOURCE org's raw record Id. That Id doesn't
// exist in the target org, so every load fails with FIELD_INTEGRITY_EXCEPTION /
// INVALID_CROSS_REFERENCE_KEY. buildIdToRefMap + resolveObjectLookupRefs fix this by rewriting
// the seed files ourselves, turning raw Ids into "@refId" placeholders that loadData's existing
// substituteRefs() already knows how to resolve at load time.
const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const { buildIdToRefMap, resolveObjectLookupRefs } = require("../out/DataMigrationEngine.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-resolve-refs-"));

// Product_Group__c was pulled first — its own seed file has real source-org Ids.
fs.writeFileSync(path.join(seedDir, "Product_Group__cs.json"), JSON.stringify({
    records: [
        { attributes: { type: "Product_Group__c", referenceId: "Product_Group__cRef3" }, Id: "a0u9r000005ej3aAAA", Name: "Speciality" },
        { attributes: { type: "Product_Group__c", referenceId: "Product_Group__cRef8" }, Id: "a0uQE000003Je4uYAC", Name: "Life" },
    ],
}));

// Product__c was pulled next, in its own isolated command — its Product_Group__c lookup still
// holds the SOURCE org's raw Ids for Product_Group__c (exactly what the real failing log showed).
fs.writeFileSync(path.join(seedDir, "Product__cs.json"), JSON.stringify({
    records: [
        { attributes: { type: "Product__c", referenceId: "Product__cRef1" }, Id: "a19...", Name: "Individual Mediclaim", Product_Group__c: "a0uQE000003Je4uYAC" },
        { attributes: { type: "Product__c", referenceId: "Product__cRef2" }, Id: "a19...", Name: "Speciality Plan", Product_Group__c: "a0u9r000005ej3aAAA" },
        { attributes: { type: "Product__c", referenceId: "Product__cRef3" }, Id: "a19...", Name: "Orphaned", Product_Group__c: "a0uNOTPULLEDXXXXXX" },
        { attributes: { type: "Product__c", referenceId: "Product__cRef4" }, Id: "a19...", Name: "Owned by a User", OwnerId: "005QE000001AbCDEF" },
    ],
}));

// ---- 1. buildIdToRefMap reads the already-pulled parent's Id -> our referenceId ----
{
    const map = buildIdToRefMap(seedDir, "Product_Group__c");
    check("maps both Product_Group__c records", map.size === 2, map.size);
    check("Ref8's real source Id maps to the right refId", map.get("a0uQE000003Je4uYAC") === "Product_Group__cRef8");
}

// ---- 2. resolveObjectLookupRefs rewrites Product__c's lookup field to @refId ----
{
    const idMaps = new Map([["Product_Group__c", buildIdToRefMap(seedDir, "Product_Group__c")]]);
    const refFields = [
        { field: "Product_Group__c", referenceTo: ["Product_Group__c"] },
        { field: "OwnerId", referenceTo: ["User"] }, // not one of our migrated objects
    ];

    const { resolved, unresolved } = resolveObjectLookupRefs(seedDir, "Product__c", refFields, idMaps);
    check("resolves the two matched records", resolved === 2, resolved);
    check("flags the one pointing at a parent Id that was never pulled", unresolved === 1, unresolved);

    const rewritten = JSON.parse(fs.readFileSync(path.join(seedDir, "Product__cs.json"), "utf-8")).records;
    check("Ref1 now points at @Product_Group__cRef8 (loadData's substituteRefs resolves this)", rewritten[0].Product_Group__c === "@Product_Group__cRef8", rewritten[0].Product_Group__c);
    check("Ref2 now points at @Product_Group__cRef3", rewritten[1].Product_Group__c === "@Product_Group__cRef3", rewritten[1].Product_Group__c);
    check("Ref3's unresolvable lookup is left as the raw Id, not silently dropped", rewritten[2].Product_Group__c === "a0uNOTPULLEDXXXXXX", rewritten[2].Product_Group__c);
    check("OwnerId (a real Salesforce user, not part of the migration) is left untouched", rewritten[3].OwnerId === "005QE000001AbCDEF", rewritten[3].OwnerId);
}

// ---- 3. Running it again (idempotent) leaves already-resolved @refId values alone ----
{
    const idMaps = new Map([["Product_Group__c", buildIdToRefMap(seedDir, "Product_Group__c")]]);
    const refFields = [{ field: "Product_Group__c", referenceTo: ["Product_Group__c"] }];
    const { resolved } = resolveObjectLookupRefs(seedDir, "Product__c", refFields, idMaps);
    check("a second pass is a no-op on values already resolved to @refId", resolved === 0, resolved);
}

fs.rmSync(seedDir, { recursive: true, force: true });

console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
process.exit(allPass ? 0 : 1);
