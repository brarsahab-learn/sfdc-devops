"use strict";
// SfCli.ts — runs the Salesforce CLI (`sf`) the same way everywhere it's invoked.
//
// On macOS, launching VS Code from the Dock/Finder (rather than `code .` from a terminal)
// gives the extension host launchd's own minimal PATH, which often omits /usr/local/bin or
// /opt/homebrew/bin — wherever `sf` actually lives. That makes every `sf` call fail with
// ENOENT even though it works fine in a real terminal. Routing through the user's own login
// shell picks up the same PATH their terminal has, regardless of how VS Code was launched.
// The "$@" trick keeps each argument as its own argv entry (not shell-interpolated), so
// values like org aliases or file paths containing spaces can't break or inject into the command.
Object.defineProperty(exports, "__esModule", { value: true });
exports.execSf = execSf;
exports.isOrgConnected = isOrgConnected;
const child_process_1 = require("child_process");
const util_1 = require("util");
const Log_1 = require("./Log");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
async function execSf(args, options) {
    (0, Log_1.debugLog)(`$ sf ${args.join(" ")}`);
    const run = process.platform === "darwin"
        ? (() => {
            const shell = process.env.SHELL || "/bin/zsh";
            return execFileAsync(shell, ["-lc", 'exec "$@"', "sf-cli", "sf", ...args], options);
        })()
        : execFileAsync("sf", args, { ...options, shell: true }); // shell:true resolves sf.cmd via PATH on Windows
    try {
        const result = await run;
        (0, Log_1.debugLog)(`$ sf ${args[0] ?? ""}${args[1] ? " " + args[1] : ""} — done (${result.stdout.length} byte(s) stdout)`);
        return result;
    }
    catch (e) {
        (0, Log_1.debugLog)(`$ sf ${args[0] ?? ""}${args[1] ? " " + args[1] : ""} — failed: ${e?.message ?? e}`);
        throw e;
    }
}
/**
 * Whether a single org alias/username is currently authenticated — `sf org display`
 * resolves exactly the one org, so it's fast (~1-2s) and correct even when `sf org list`
 * would report a different alias for the same org (an org can carry more than one alias).
 */
async function isOrgConnected(alias, workspaceRoot) {
    try {
        const { stdout } = await execSf(["org", "display", "--target-org", alias, "--json"], {
            cwd: workspaceRoot, timeout: 20000, maxBuffer: 2 * 1024 * 1024,
        });
        const parsed = JSON.parse(stdout);
        return parsed?.result?.connectedStatus === "Connected";
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=SfCli.js.map