// Every button that embeds a string value via `${JSON.stringify(x)}` inside a double-quoted
// onclick="..." HTML attribute breaks the moment that value gets rendered, because
// JSON.stringify() always wraps its result in literal `"` characters — which HTML parses as the
// END of the onclick attribute. The rest of the intended JS (and the value itself) spills out as
// bare, invalid markup, so the button's onclick becomes truncated garbage that throws a
// SyntaxError on click and does nothing. This is exactly why Retry Failed / Clear & Reload / Full
// Rollback / Export CSV / Refresh (Tracking tab) and Re-check / Auto-Create All (ExternalId tab)
// silently failed. Confirmed with a real DOM parser: an attribute like
// onclick="send('x',{a:"foo"})" comes back from the browser as onclick=`send('x',{a:` — nothing
// after the first embedded quote is even part of the attribute.
const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const dmConfig = require("../out/DataMigrationConfig.js");
dmConfig.readDmConfig = () => ({
    objects: [{ id: "a", sobject: "Broker__c", active: true, externalIdVerified: false }],
    autoCreateExternalId: true, batchSize: 190, seedDir: ".git/sf-devops-dm/seed",
});
dmConfig.getSourceOrg = () => "";
dmConfig.getTargetOrg = () => "myOrg";
dmConfig.readTracking = () => ({ Broker__c: { Ref1: { status: "failed", error: "boom" } } });
dmConfig.lastRunLogPath = () => "/tmp/does-not-exist";
dmConfig.pullLogsDir = () => "/tmp/does-not-exist";
dmConfig.loadLogsDir = () => "/tmp/does-not-exist";
dmConfig.listRecentLogs = () => [];

const roleMgr = require("../out/RoleManager.js");
roleMgr.getEffectiveRole = () => "Admin";
const cfg = require("../out/config.js");
cfg.getRoles = () => ["Dev", "Lead", "Admin"];
cfg.getEnvironments = () => ({});
cfg.getOrgAliasSlots = () => ({});

const { DataMigrationPanel } = require("../out/providers/DataMigrationPanel.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

function makePanel(activeTab) {
    const panel = Object.create(DataMigrationPanel.prototype);
    panel._workspaceRoot = "/tmp/fake-ws";
    panel._ctx = { globalState: { get: () => undefined } };
    panel._panel = { webview: { postMessage: () => {}, asWebviewUri: (u) => u, cspSource: "self" } };
    panel._config = dmConfig.readDmConfig();
    panel._activeTab = activeTab;
    panel._pullState = "idle";
    panel._loadState = "idle";
    panel._extBusy = false;
    panel._extBusyLabel = "";
    panel._lastError = null;
    panel._pullLog = [];
    panel._loadLog = [];
    panel._trackingViewOrg = "myOrg";
    panel._availableOrgs = [];
    panel._dryRunMode = false;
    return panel;
}

// A minimal decoder for the handful of entities esc() produces — enough to prove the decoded
// onclick body is valid JS, without pulling in a full HTML parser.
function decodeEntities(s) {
    return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function checkAllOnclicksSafe(html, label) {
    const re = /onclick="([^"]*)"/g;
    let m;
    let count = 0;
    while ((m = re.exec(html))) {
        count++;
        const raw = m[1];
        // If any embedded JSON.stringify output had leaked through unescaped, the regex itself
        // would have stopped at the first embedded quote, producing a short, clearly-truncated
        // attribute body that isn't valid JS. Decode entities and verify it parses.
        const decoded = decodeEntities(raw);
        try {
            new Function(decoded);
        } catch (e) {
            check(`${label}: onclick #${count} is valid JS`, false, JSON.stringify(raw));
            continue;
        }
    }
    check(`${label}: found ${count} onclick attribute(s) and all parsed as valid JS`, count > 0);
}

checkAllOnclicksSafe(makePanel("tracking")._renderHtml(makePanel("tracking")._buildViewModel()), "Tracking tab");
checkAllOnclicksSafe(makePanel("extids")._renderHtml(makePanel("extids")._buildViewModel()), "ExternalId tab");
checkAllOnclicksSafe(makePanel("config")._renderHtml(makePanel("config")._buildViewModel()), "Config tab");
checkAllOnclicksSafe(makePanel("pull")._renderHtml(makePanel("pull")._buildViewModel()), "Pull tab");

// The redesign (5.3.2) removed field-creation entirely — the extension never creates Salesforce
// custom fields, so BOTH the per-object "Auto-Create" and bulk "Auto-Create All Missing" buttons
// are gone; the ExternalId tab is verify-only now.
{
    const html = makePanel("extids")._renderHtml(makePanel("extids")._buildViewModel());
    check("per-object Auto-Create button is removed", !html.includes(">Auto-Create<"));
    check("bulk Auto-Create All Missing button is removed", !html.includes("Auto-Create All Missing"));
}

console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
process.exit(allPass ? 0 : 1);
