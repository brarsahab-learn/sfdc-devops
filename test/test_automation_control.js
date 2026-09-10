// enableAutomationControl / restoreAutomationControl set/unset two things around a load: (1) the
// running user's override of DataMigrationControls__c (a hierarchy custom setting), and (2)
// User.Skip_Lookup_Filters__c on the running user's own record. The critical behavior in both
// cases: restore the ORIGINAL value afterward — for the custom setting, delete it if we created
// it fresh, restore original field values if it already existed; for the User field, always
// restore whatever it was before (the User record always exists, no create/delete concept).
// Getting either backwards would leave a real user's org automation silently disabled forever.
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

function baseMock({ existingCustomSetting, existingSkipLookupFilters }) {
    const calls = [];
    return {
        calls,
        execSf: async (args) => {
            calls.push(args.join(" "));
            if (args[0] === "org" && args[1] === "display") {
                return jsonOut({ result: { username: "runner@org.com" } });
            }
            if (args[0] === "data" && args[1] === "query" && args.some(a => a.includes("FROM User WHERE Username"))) {
                return jsonOut({ result: { records: [{ Id: "005000000000001" }] } });
            }
            if (args[0] === "data" && args[1] === "query" && args.some(a => a.includes("FROM DataMigrationControls__c"))) {
                return jsonOut({ result: { records: existingCustomSetting ? [existingCustomSetting] : [] } });
            }
            if (args[0] === "data" && args[1] === "query" && args.some(a => a.includes("FROM User WHERE Id"))) {
                return jsonOut({ result: { records: [{ Skip_Lookup_Filters__c: existingSkipLookupFilters }] } });
            }
            if (args[0] === "data" && args[1] === "create" && args.includes("DataMigrationControls__c")) {
                return jsonOut({ result: { id: "a0Enew00000000001" } });
            }
            if (args[0] === "data" && args[1] === "update" && args.includes("DataMigrationControls__c")) {
                return jsonOut({ result: { id: existingCustomSetting ? existingCustomSetting.Id : "a0Enew00000000001" } });
            }
            if (args[0] === "data" && args[1] === "update" && args.includes("User")) {
                return jsonOut({ result: { id: "005000000000001" } });
            }
            if (args[0] === "data" && args[1] === "delete") {
                return jsonOut({ result: { id: args[args.indexOf("--record-id") + 1] } });
            }
            throw new Error("unexpected execSf call: " + args.join(" "));
        },
    };
}

(async () => {
    // ---- 1. No existing custom-setting override, Skip_Lookup_Filters__c currently false ----
    {
        const mock = baseMock({ existingCustomSetting: null, existingSkipLookupFilters: false });
        sfCli.execSf = mock.execSf;

        const state = await enableAutomationControl("myOrg", "/tmp/ws", noopLog);
        check("custom setting: reports created:true", state?.customSetting?.created === true);
        check("custom setting: new record id captured", state?.customSetting?.recordId === "a0Enew00000000001");
        check("user field: original value (false) captured", state?.userLookupFilters?.originalValue === false, JSON.stringify(state?.userLookupFilters));

        const userUpdateCall = mock.calls.find(c => c.startsWith("data update record") && c.includes("--sobject User"));
        check("enable sets Skip_Lookup_Filters__c=true on the user", userUpdateCall?.includes("Skip_Lookup_Filters__c=true"), userUpdateCall);

        mock.calls.length = 0;
        await restoreAutomationControl("myOrg", "/tmp/ws", state, noopLog);
        const deleteCall = mock.calls.find(c => c.startsWith("data delete record"));
        check("restore deletes the created custom-setting override", deleteCall?.includes("a0Enew00000000001"), deleteCall);
        const restoreUserCall = mock.calls.find(c => c.startsWith("data update record") && c.includes("--sobject User"));
        check("restore sets Skip_Lookup_Filters__c back to false", restoreUserCall?.includes("Skip_Lookup_Filters__c=false"), restoreUserCall);
    }

    // ---- 2. Existing custom-setting override with mixed values, Skip_Lookup_Filters__c currently true ----
    {
        const existing = {
            Id: "a0Eexisting001",
            Disable_Emails_Notifications__c: false,
            Disable_Flows__c: true,
            Disable_Lookup_Filters__c: false,
            Disable_Notification_Flows__c: false,
            Disable_Triggers__c: true,
            Disable_Validation_Rules__c: false,
        };
        const mock = baseMock({ existingCustomSetting: existing, existingSkipLookupFilters: true });
        sfCli.execSf = mock.execSf;

        const state = await enableAutomationControl("myOrg", "/tmp/ws", noopLog);
        check("custom setting: reports created:false", state?.customSetting?.created === false);
        check("custom setting: original mixed values captured", state?.customSetting?.originalValues?.Disable_Flows__c === true
            && state?.customSetting?.originalValues?.Disable_Emails_Notifications__c === false,
            JSON.stringify(state?.customSetting?.originalValues));
        check("user field: original value (true) captured", state?.userLookupFilters?.originalValue === true);

        const enableCustomUpdate = mock.calls.find(c => c.startsWith("data update record") && c.includes("DataMigrationControls__c"));
        check("enable sets ALL custom-setting fields to true regardless of original values", enableCustomUpdate?.includes("Disable_Emails_Notifications__c=true") && enableCustomUpdate?.includes("Disable_Flows__c=true"));

        mock.calls.length = 0;
        await restoreAutomationControl("myOrg", "/tmp/ws", state, noopLog);
        const restoreCustomUpdate = mock.calls.find(c => c.startsWith("data update record") && c.includes("DataMigrationControls__c"));
        check("restore writes back the exact original mixed custom-setting values", restoreCustomUpdate?.includes("Disable_Emails_Notifications__c=false") && restoreCustomUpdate?.includes("Disable_Flows__c=true"), restoreCustomUpdate);
        const restoreUserCall = mock.calls.find(c => c.startsWith("data update record") && c.includes("--sobject User"));
        check("restore sets Skip_Lookup_Filters__c back to true (its original value)", restoreUserCall?.includes("Skip_Lookup_Filters__c=true"), restoreUserCall);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
