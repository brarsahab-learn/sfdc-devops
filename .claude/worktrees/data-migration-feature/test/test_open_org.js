const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const { StoryWebviewProvider } = require("../out/providers/StoryWebviewProvider.js");
const config = require("../out/config.js");
config.getCurrentRole = () => "Admin";

const provider = Object.create(StoryWebviewProvider.prototype);
provider._extContext = { globalState: { get: () => undefined, update: async () => undefined } };

const slots = [
    { key: "dev", label: "DEV", alias: "QA1-ZIB" },
    { key: "qa", label: "QA", alias: "QA-LIVE" },
    { key: "uat", label: "UAT", alias: "UAT-LIVE" },
];

const editableHtml = provider._renderOrgAliasSlots(slots, true, { dev: true, qa: true, uat: true });
const readonlyHtml = provider._renderOrgAliasSlots(slots, false, { dev: true, qa: true, uat: true });

const checks = [
    ["editable: open button present per row", (editableHtml.match(/openOrgFromInput\('(dev|qa|uat)'\)/g) || []).length === 3],
    ["editable: 🌐 icon rendered", (editableHtml.match(/🌐/g) || []).length === 3],
    ["readonly: open button uses literal alias", readonlyHtml.includes("openOrg('QA1-ZIB')") && readonlyHtml.includes("openOrg('QA-LIVE')") && readonlyHtml.includes("openOrg('UAT-LIVE')")],
    ["readonly: 🌐 icon rendered", (readonlyHtml.match(/🌐/g) || []).length === 3],
];

// No-alias slot should not render a broken open button in read-only mode
const emptySlot = [{ key: "prod", label: "PROD", alias: "" }];
const emptyHtml = provider._renderOrgAliasSlots(emptySlot, false, {});
checks.push(["readonly: no open button when alias unset", !emptyHtml.includes("🌐")]);

let allPass = true;
for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
    if (!pass) { allPass = false; }
}
process.exit(allPass ? 0 : 1);
