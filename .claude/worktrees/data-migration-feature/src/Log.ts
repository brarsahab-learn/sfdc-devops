// Log.ts — a single shared Output Channel ("Salesforce-DevOps") that narrates what every
// promotion/deployment/validation is actually doing, in plain language — which files are
// being picked up, what succeeded or failed and why — rather than a silent spinner, and
// deliberately NOT a raw dump of every git/sf command or CLI JSON output (unreadable noise).

import * as vscode from "vscode";
import { isVerboseLogsEnabled } from "./config";

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    if (!channel) { channel = vscode.window.createOutputChannel("Salesforce-DevOps"); }
    return channel;
}

/** Registers the channel for disposal on deactivate — call once from activate(). */
export function initLog(context: vscode.ExtensionContext): void {
    context.subscriptions.push(getChannel());
}

export function log(message: string): void {
    getChannel().appendLine(message);
}

/** Logs and brings the Output panel into view — for the start of a user-initiated action (promote/deploy/validate), not silent background polling (e.g. Setup Check's org-status probes). */
export function revealLog(message: string): void {
    log(message);
    getChannel().show(true); // preserveFocus: don't steal focus from the editor
}

/**
 * Same channel, but gated behind sfDevops.enableVerboseLogs — this is the escape hatch for
 * everything the plain narration above deliberately leaves out: the exact git/sf command line
 * about to run, the full CLI argument list, raw job/deploy IDs and their live status. A no-op
 * (and doesn't even touch the channel) when the setting is off, so it's free to sprinkle at
 * every command-building/job-status call site without adding noise for the default reader.
 */
let verboseRevealed = false;

export function debugLog(message: string): void {
    if (!isVerboseLogsEnabled()) { return; }
    if (!verboseRevealed) {
        // First verbose line of the session — surface the channel once so turning the setting
        // on actually shows something, without popping it open on every single line after that.
        verboseRevealed = true;
        getChannel().show(true);
    }
    getChannel().appendLine(`[verbose] ${message}`);
}
