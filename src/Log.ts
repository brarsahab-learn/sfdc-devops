// Log.ts — a single shared Output Channel ("Salesforce DevOps") that narrates what every
// promotion/deployment/validation is actually doing, in plain language — which files are
// being picked up, what succeeded or failed and why — rather than a silent spinner, and
// deliberately NOT a raw dump of every git/sf command or CLI JSON output (unreadable noise).

import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    if (!channel) { channel = vscode.window.createOutputChannel("Salesforce DevOps"); }
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
