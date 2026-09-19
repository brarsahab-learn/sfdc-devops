// Regression test for a real reported bug: StoryPipelinePanel embedded JSON.stringify()
// output inside a single-quoted `JSON.parse('...')` JS string literal, escaping only
// </script>-relevant characters (<, >, &) — never the single quote the whole thing was
// wrapped in. A story ID or branch name containing a literal apostrophe (which
// extractStoryId's fallback-to-raw-branch-name path can produce for any branch not
// created through "Start New Story") broke the entire script block outright. The same
// pattern was found (and fixed) in StoryJourneyPanel.ts and DiffViewerPanel.ts too.

const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
require(path.join(__dirname, "fake-vscode.js"));

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

/** Extracts the JS embedded in <script>...</script> and confirms it actually parses as valid JS — the real-world failure mode was a SyntaxError at this exact point. */
function assertScriptParses(html, label) {
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!match) { check(`${label}: found a <script> block to check`, false); return; }
    try {
        new Function(match[1].replace(/acquireVsCodeApi\(\)/g, "({postMessage(){}})"));
        check(`${label}: embedded script is syntactically valid JS`, true);
    } catch (e) {
        check(`${label}: embedded script is syntactically valid JS`, false, e.message);
    }
}

(async () => {
    // ---- 1. StoryPipelinePanel: a story ID with a literal apostrophe (the exact reported bug) ----
    {
        const { StoryPipelinePanel } = require("../out/providers/StoryPipelinePanel.js");
        const panel = Object.create(StoryPipelinePanel.prototype);
        const html = panel._renderHtml([{
            storyId: "John's-fix", branch: "feature/John's-fix", lastActivity: "2026-09-05T12:00:00+10:00",
            stageIndex: 0, stageName: "Dev", isStale: false, isComplete: false, isInactive: false, ticketUrl: undefined,
        }]);
        assertScriptParses(html, "StoryPipelinePanel (apostrophe in story ID)");
        check("story ID with an apostrophe still renders visibly in the HTML", html.includes("John&#39;s-fix") || html.includes("John's-fix"), html.includes("John's-fix"));
    }

    // ---- 2. StoryJourneyPanel: same, for the VALID_IDS embedding ----
    {
        const { StoryJourneyPanel } = require("../out/providers/StoryJourneyPanel.js");
        const panel = Object.create(StoryJourneyPanel.prototype);
        const html = panel._renderHtml("TEST-1", [], [], ["TEST-1", "O'Brien-fix"]);
        assertScriptParses(html, "StoryJourneyPanel (apostrophe in allStoryIds)");
    }

    // ---- 3. DiffViewerPanel: same, for REFS/PIPELINE_PAIRS ----
    {
        const { DiffViewerPanel } = require("../out/providers/DiffViewerPanel.js");
        const panel = Object.create(DiffViewerPanel.prototype);
        const html = panel._buildHtml(
            [{ label: "feature/O'Brien-fix", ref: "feature/O'Brien-fix" }, { label: "qa", ref: "qa" }],
            "qa", "feature/O'Brien-fix",
            [{ fromLabel: "Dev", toLabel: "QA", from: "dev", to: "qa" }]
        );
        assertScriptParses(html, "DiffViewerPanel (apostrophe in a ref label)");
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
