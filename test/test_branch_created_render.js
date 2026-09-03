const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const { StoryWebviewProvider } = require("../out/providers/StoryWebviewProvider.js");
const config = require("../out/config.js");

config.getEnvironments = () => [
    { name: "dev", label: "Dev", branch: "dev", isProd: false },
    { name: "qa", label: "QA", branch: "qa", isProd: false },
];
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev" });
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", isProd: false }];
config.getCoverageGateEnvironment = () => undefined;
config.getCurrentRole = () => "Admin";

const provider = Object.create(StoryWebviewProvider.prototype);
provider._bbClient = { buildPrUrl: () => null };
provider._extContext = {
    extension: { packageJSON: { version: "3.17.0" } },
    globalState: { get: () => undefined, update: async () => undefined },
};
provider._forceShowSetup = false;

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

const progress = { dev: "published", qa: "branch-created" };
const html = provider._getWebviewHtml("feature/TEST-1", "TEST-1", progress, 0, undefined, undefined, {}, undefined, {});

check("QA shows the new branch-created label", html.includes("Branch created — validation required"));
check("QA shows the 🧪 icon", /<div class="pdot">🧪<\/div>/.test(html));
check("no unresolved template artifacts", !/undefined|\[object Object\]/.test(html));
check("Validate/Promote CTA still available (branch-created falls into the normal nextEnv CTA path)", html.includes("Validate Only") && html.includes("Promote"));

// ---- Not-yet-validated: Validate Only should be the primary (next applicable) action ----
{
    const validateIdx = html.indexOf("Validate Only");
    const promoteIdx  = html.indexOf(">&#x1F680; Promote");
    check("Validate Only appears before Promote when not yet validated", validateIdx !== -1 && promoteIdx !== -1 && validateIdx < promoteIdx);
    const validateBtnHtml = html.slice(html.lastIndexOf("<button", validateIdx), validateIdx);
    const promoteBtnHtml  = html.slice(html.lastIndexOf("<button", promoteIdx), promoteIdx);
    check("Validate Only is btn-primary pre-validation", validateBtnHtml.includes("btn-primary"));
    check("Promote is btn-secondary pre-validation", promoteBtnHtml.includes("btn-secondary"));
}

// ---- Already validated ("open"): Promote should become the primary action ----
{
    const progress2 = { dev: "published", qa: "open" };
    const html2 = provider._getWebviewHtml("feature/TEST-1", "TEST-1", progress2, 0, undefined, undefined, {}, undefined, {});
    const promoteIdx  = html2.indexOf(">&#x1F680; Promote");
    const revalidateIdx = html2.indexOf("Re-validate");
    check("Promote appears before Re-validate once validated", promoteIdx !== -1 && revalidateIdx !== -1 && promoteIdx < revalidateIdx);
    const promoteBtnHtml  = html2.slice(html2.lastIndexOf("<button", promoteIdx), promoteIdx);
    const revalidateBtnHtml = html2.slice(html2.lastIndexOf("<button", revalidateIdx), revalidateIdx);
    check("Promote is btn-primary once validated", promoteBtnHtml.includes("btn-primary"));
    check("Re-validate is btn-secondary once validated", revalidateBtnHtml.includes("btn-secondary"));
}

process.exit(allPass ? 0 : 1);
