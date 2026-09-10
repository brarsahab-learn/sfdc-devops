// enableAutomationControl / restoreAutomationControl set/unset the running user's override of
// DataMigrationControls__c (a hierarchy custom setting) around a load. The critical behavior:
// if an override already existed, restore its ORIGINAL values afterward (never leave it stuck on
// true); if we created it fresh, delete it afterward rather than leaving a stray record behind.
// Getting this backwards would leave a real user's org automation silently disabled forever.
const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const sfCli = require("../out/SfCli.js");
const { enableAutomationControl, restoreAutomationControl } = require("../out/DataMigrationEngine.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }
function noopLog() {}

function jsonOut(obj) { return { stdout: JSON.stringify(obj) }; }

// ---- 1. No existing override: creates one, then deletes it on restore ----
(async () => {
    const calls = [];
    sfCli.execSf = async (args) => {
        calls.push(args.join(" "));
        if (args[0] === "org" && args[1] === "display") {
            return jsonOut({ result: { username: "runner@org.com" } });
        }
        if (args[0] === "data" && args[1] === "query" && args.some(a => a.includes("FROM User"))) {
            return jsonOut({ result: { records: [{ Id: "005000000000001" }] } });
        }
        if (args[0] === "data" && args[1] === "query" && args.some(a => a.includes("FROM DataMigrationControls__c"))) {
            return jsonOut({ result: { records: [] } }); // no existing override
        }
        if (args[0] === "data" && args[1] === "create") {
            check("create record includes SetupOwnerId=running user", args.includes("SetupOwnerId=005000000000001 Disable_Emails_Notifications__c=true Disable_Flows__c=true Disable_Lookup_Filters__c=true Disable_Notification_Flows__c=true Disable_Triggers__c=true Disable_Validation_Rules__c=true") || args.some(a => a.includes("SetupOwnerId=005000000000001")));
            return jsonOut({ result: { id: "a0Enew00000000001" } });
        }
        if (args[0] === "data" && args[1] === "delete") {
            return jsonOut({ result: { id: args[args.indexOf("--record-id") + 1] } });
        }
        throw new Error("unexpected execSf call: " + args.join(" "));
    };

    const state = await enableAutomationControl("myOrg", "/tmp/ws", noopLog);
    check("no-existing-override case reports created:true", state && state.created === true);
    check("new record id captured", state && state.recordId === "a0Enew00000000001");

    calls.length = 0;
    await restoreAutomationControl("myOrg", "/tmp/ws", state, noopLog);
    const deleteCall = calls.find(c => c.startsWith("data delete record"));
    check("restore deletes the created override record", !!deleteCall && deleteCall.includes("a0Enew00000000001"), deleteCall);
})().then(async () => {
    // ---- 2. Existing override with mixed values: restores exactly those original values ----
    let updateCalls = [];
    sfCli.execSf = async (args) => {
        if (args[0] === "org" && args[1] === "display") { return jsonOut({ result: { username: "runner@org.com" } }); }
        if (args[0] === "data" && args[1] === "query" && args.some(a => a.includes("FROM User"))) {
            return jsonOut({ result: { records: [{ Id: "005000000000001" }] } });
        }
        if (args[0] === "data" && args[1] === "query" && args.some(a => a.includes("FROM DataMigrationControls__c"))) {
            return jsonOut({
                result: {
                    records: [{
                        Id: "a0Eexisting001",
                        Disable_Emails_Notifications__c: false,
                        Disable_Flows__c: true,
                        Disable_Lookup_Filters__c: false,
                        Disable_Notification_Flows__c: false,
                        Disable_Triggers__c: true,
                        Disable_Validation_Rules__c: false,
                    }],
                },
            });
        }
        if (args[0] === "data" && args[1] === "update") {
            updateCalls.push(args.join(" "));
            return jsonOut({ result: { id: "a0Eexisting001" } });
        }
        throw new Error("unexpected execSf call: " + args.join(" "));
    };

    const state = await enableAutomationControl("myOrg", "/tmp/ws", noopLog);
    check("existing-override case reports created:false", state && state.created === false);
    check("original (mixed) values captured before overwriting", state
        && state.originalValues.Disable_Emails_Notifications__c === false
        && state.originalValues.Disable_Flows__c === true
        && state.originalValues.Disable_Triggers__c === true,
        JSON.stringify(state && state.originalValues));

    const enableUpdate = updateCalls[0];
    check("enable sets ALL fields to true regardless of original values", enableUpdate.includes("Disable_Emails_Notifications__c=true") && enableUpdate.includes("Disable_Flows__c=true"));

    updateCalls = [];
    await restoreAutomationControl("myOrg", "/tmp/ws", state, noopLog);
    const restoreUpdate = updateCalls[0];
    check("restore writes back the exact original mixed values, not all-false", restoreUpdate
        && restoreUpdate.includes("Disable_Emails_Notifications__c=false")
        && restoreUpdate.includes("Disable_Flows__c=true")
        && restoreUpdate.includes("Disable_Triggers__c=true"),
        restoreUpdate);

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
});
