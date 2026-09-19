// Files that were committed BEFORE being added to .gitignore stay tracked forever — plain
// `git add .`/`-A` restages their modifications regardless of .gitignore, and raw
// `git status --porcelain` still reports them as uncommitted changes. That means every
// "you have uncommitted changes" gate (Promote/Validate/Deploy/Resume) blocks on a file the
// user never intended to touch, and the actual staging calls (commitAllChanges,
// continuePendingOperation) keep re-committing it. This test proves GitHelper treats
// tracked-but-.gitignore'd files as invisible to both the uncommitted-changes gate and to
// staging, that real changes are unaffected, that secret-shaped untracked files are never
// staged, and that the one-time cleanup command actually untracks them.
const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
const os = require("os");
const fs = require("fs");
const TMP_REPO = fs.mkdtempSync(path.join(os.tmpdir(), "sfdevops-ignoretest-"));
fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: TMP_REPO } }];
fakeVscode.workspace.getConfiguration = () => ({ get: () => undefined });

const { execSync } = require("child_process");
function run(cmd) { execSync(cmd, { cwd: TMP_REPO }); }
function write(relPath, content) { fs.writeFileSync(path.join(TMP_REPO, relPath), content); }
function read(relPath) { return fs.readFileSync(path.join(TMP_REPO, relPath), "utf8"); }

run("git init -q -b main");
run("git config user.email test@test.com && git config user.name Test");

const { GitHelper } = require("../out/GitHelper.js");
const gh = new GitHelper();

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- Setup: commit a file, THEN add it to .gitignore (so it stays tracked-but-ignored) ----
    write("ignored.txt", "v1");
    run("git add -A && git commit -q -m init");
    write(".gitignore", "ignored.txt\n");
    run("git add .gitignore && git commit -q -m 'add gitignore'");
    write("ignored.txt", "v2"); // local modification to the now-ignored-but-tracked file

    // ---- trackedIgnoredFiles: finds it ----
    const tracked = await gh.trackedIgnoredFiles();
    check("trackedIgnoredFiles finds the tracked-but-ignored file", tracked.includes("ignored.txt"), JSON.stringify(tracked));

    // ---- hasUncommittedChanges / workingTreeFiles ignore it when it's the only change ----
    check("hasUncommittedChanges is false when only the ignored file changed", !(await gh.hasUncommittedChanges()));
    check("workingTreeFiles is empty when only the ignored file changed", (await gh.workingTreeFiles()).length === 0);

    // ---- A real change is still reported once one exists ----
    write("real.txt", "hello");
    check("hasUncommittedChanges is true once a real file changes too", await gh.hasUncommittedChanges());
    const wtFiles = await gh.workingTreeFiles();
    check("workingTreeFiles reports the real file", wtFiles.includes("real.txt"), JSON.stringify(wtFiles));
    check("workingTreeFiles excludes the ignored file", !wtFiles.includes("ignored.txt"), JSON.stringify(wtFiles));

    // ---- commitAllChanges stages the real file but never the tracked-ignored one ----
    const committed = await gh.commitAllChanges("chore: test commit");
    check("commitAllChanges reports it committed something", committed === true);
    const lastCommitFiles = execSync("git show --name-only --format=", { cwd: TMP_REPO }).toString();
    check("the commit includes real.txt", lastCommitFiles.includes("real.txt"), lastCommitFiles);
    check("the commit does NOT include ignored.txt", !lastCommitFiles.includes("ignored.txt"), lastCommitFiles);
    check("ignored.txt's local modification (v2) is still sitting uncommitted", read("ignored.txt") === "v2" && (await gh.trackedIgnoredFiles()).includes("ignored.txt"));

    // ---- Secret-shaped untracked files are never staged ----
    write("real2.txt", "more real work");
    write(".env", "API_KEY=super-secret");
    const skippedFromEnv = await gh.commitAllChanges("chore: second commit");
    check("commitAllChanges committed the second real change", skippedFromEnv === true);
    const secondCommitFiles = execSync("git show --name-only --format=", { cwd: TMP_REPO }).toString();
    check("second commit includes real2.txt", secondCommitFiles.includes("real2.txt"), secondCommitFiles);
    check("second commit does NOT include .env", !secondCommitFiles.includes(".env"), secondCommitFiles);
    const statusAfter = execSync("git status --porcelain", { cwd: TMP_REPO }).toString();
    check(".env is still untracked afterward", statusAfter.includes("?? .env"), statusAfter);

    // ---- untrackIgnoredFiles: the one-time cleanup ----
    await gh.untrackIgnoredFiles(["ignored.txt"]);
    check("ignored.txt is no longer tracked after cleanup", (await gh.trackedIgnoredFiles()).length === 0);
    const lsFiles = execSync("git ls-files", { cwd: TMP_REPO }).toString();
    check("git itself confirms ignored.txt is untracked", !lsFiles.includes("ignored.txt"), lsFiles);
    check("ignored.txt still exists on disk", fs.existsSync(path.join(TMP_REPO, "ignored.txt")));

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    fs.rmSync(TMP_REPO, { recursive: true, force: true });
    process.exit(allPass ? 0 : 1);
})();
