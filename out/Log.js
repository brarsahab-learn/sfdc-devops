"use strict";
// Log.ts — a single shared Output Channel ("Salesforce-DevOps") that narrates what every
// promotion/deployment/validation is actually doing, in plain language — which files are
// being picked up, what succeeded or failed and why — rather than a silent spinner, and
// deliberately NOT a raw dump of every git/sf command or CLI JSON output (unreadable noise).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLog = initLog;
exports.log = log;
exports.revealLog = revealLog;
exports.debugLog = debugLog;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
let channel;
function getChannel() {
    if (!channel) {
        channel = vscode.window.createOutputChannel("Salesforce-DevOps");
    }
    return channel;
}
/** Registers the channel for disposal on deactivate — call once from activate(). */
function initLog(context) {
    context.subscriptions.push(getChannel());
}
function log(message) {
    getChannel().appendLine(message);
}
/** Logs and brings the Output panel into view — for the start of a user-initiated action (promote/deploy/validate), not silent background polling (e.g. Setup Check's org-status probes). */
function revealLog(message) {
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
function debugLog(message) {
    if (!(0, config_1.isVerboseLogsEnabled)()) {
        return;
    }
    if (!verboseRevealed) {
        // First verbose line of the session — surface the channel once so turning the setting
        // on actually shows something, without popping it open on every single line after that.
        verboseRevealed = true;
        getChannel().show(true);
    }
    getChannel().appendLine(`[verbose] ${message}`);
}
//# sourceMappingURL=Log.js.map