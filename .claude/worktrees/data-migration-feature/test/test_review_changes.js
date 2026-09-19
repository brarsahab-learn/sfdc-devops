const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const { GitRefContentProvider, buildDiffUris, SF_DEVOPS_DIFF_SCHEME } = require("../out/DiffContentProvider.js");

    // ---- 1. buildDiffUris: distinct URIs, right scheme, right ref encoded in the query ----
    {
        const { before, after } = buildDiffUris("force-app/main/default/classes/Foo.cls", "qa", "feature/TEST-9");
        check("before URI carries the target ref", before.toString().includes("ref=qa"), before.toString());
        check("after URI carries the feature ref (URL-encoded slash)", after.toString().includes(encodeURIComponent("feature/TEST-9")), after.toString());
        check("both URIs use the sfdevops-diff scheme", before.toString().startsWith(SF_DEVOPS_DIFF_SCHEME + ":") && after.toString().startsWith(SF_DEVOPS_DIFF_SCHEME + ":"));
        check("before and after are distinct URIs", before.toString() !== after.toString());
    }

    // ---- 2. GitRefContentProvider: resolves real content from a ref+path, "" when the file doesn't exist there ----
    {
        const calls = [];
        const gh = {
            fileContentAtRef: async (ref, filePath) => {
                calls.push({ ref, filePath });
                if (ref === "qa" && filePath === "force-app/main/default/classes/Foo.cls") { return "public class Foo {}"; }
                return null; // simulates a file that doesn't exist at this ref (added/deleted)
            },
        };
        const provider = new GitRefContentProvider(gh);

        const existing = await provider.provideTextDocumentContent({ path: "/force-app/main/default/classes/Foo.cls", query: "ref=qa" });
        check("returns real content for an existing ref+path", existing === "public class Foo {}", existing);
        check("passed the ref from the query string, not the raw query", calls[0].ref === "qa", JSON.stringify(calls[0]));
        check("stripped the leading slash from the URI path", calls[0].filePath === "force-app/main/default/classes/Foo.cls", calls[0].filePath);

        const missing = await provider.provideTextDocumentContent({ path: "/force-app/main/default/classes/New.cls", query: "ref=qa" });
        check("returns an empty string (not null/undefined) for a file that doesn't exist at that ref", missing === "", JSON.stringify(missing));
    }

    // ---- 3. reviewStoryDiff: opens vscode.diff for the picked file, current(target) on the left, incoming(feature) on the right, then loops ----
    {
        const { reviewStoryDiff } = require("../out/commands/promoteStory.js");

        const picks = ["force-app/main/default/classes/Foo.cls", undefined]; // pick once, then Esc to close
        fakeVscode.window.showQuickPick = async (items) => {
            const label = picks.shift();
            if (!label) { return undefined; }
            return items.find(i => i.file.path === label);
        };
        const diffCalls = [];
        fakeVscode.commands.executeCommand = async (cmd, before, after, title) => {
            diffCalls.push({ cmd, before: before.toString(), after: after.toString(), title });
        };

        const files = [
            { path: "force-app/main/default/classes/Foo.cls", change: "modified" },
            { path: "force-app/main/default/classes/Bar.cls", change: "added" },
        ];
        await reviewStoryDiff({}, "feature/TEST-9", "qa", files);

        check("opened exactly one diff (Esc after the first pick stopped the loop)", diffCalls.length === 1, diffCalls.length);
        check("used the vscode.diff command", diffCalls[0].cmd === "vscode.diff");
        check("left side (before) is the CURRENT content — target branch", diffCalls[0].before.includes("ref=qa"), diffCalls[0].before);
        check("right side (after) is the INCOMING content — feature branch", diffCalls[0].after.includes(encodeURIComponent("feature/TEST-9")), diffCalls[0].after);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
