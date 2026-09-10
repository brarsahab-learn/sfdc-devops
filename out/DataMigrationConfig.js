"use strict";
// DataMigrationConfig.ts — read/write the .sf-devops-dm.json config and org-selection state.
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
exports.readDmConfig = readDmConfig;
exports.writeDmConfig = writeDmConfig;
exports.getSourceOrg = getSourceOrg;
exports.getTargetOrg = getTargetOrg;
exports.setSourceOrg = setSourceOrg;
exports.setTargetOrg = setTargetOrg;
exports.dmBaseDir = dmBaseDir;
exports.ensureDmDirs = ensureDmDirs;
exports.safeOrgName = safeOrgName;
exports.trackingFilePath = trackingFilePath;
exports.readTracking = readTracking;
exports.writeTracking = writeTracking;
exports.appendHistoryEntry = appendHistoryEntry;
exports.writeLastRunLog = writeLastRunLog;
exports.lastRunLogPath = lastRunLogPath;
exports.pullLogsDir = pullLogsDir;
exports.loadLogsDir = loadLogsDir;
exports.writeJobLog = writeJobLog;
exports.listRecentLogs = listRecentLogs;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const CONFIG_FILE = ".sf-devops-dm.json";
const SOURCE_ORG_KEY = "sfDevops.dm.sourceOrg";
const TARGET_ORG_KEY = "sfDevops.dm.targetOrg";
const DEFAULT_CONFIG = {
    objects: [],
    seedDir: ".git/sf-devops-dm/seed",
    batchSize: 190,
};
function readDmConfig(workspaceRoot) {
    const filePath = path.join(workspaceRoot, CONFIG_FILE);
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        return {
            objects: parsed.objects ?? [],
            seedDir: parsed.seedDir ?? DEFAULT_CONFIG.seedDir,
            batchSize: parsed.batchSize ?? 190,
        };
    }
    catch {
        return { ...DEFAULT_CONFIG, objects: [] };
    }
}
function writeDmConfig(workspaceRoot, config) {
    const filePath = path.join(workspaceRoot, CONFIG_FILE);
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}
function getSourceOrg(ctx) {
    return ctx.workspaceState.get(SOURCE_ORG_KEY);
}
function getTargetOrg(ctx) {
    return ctx.workspaceState.get(TARGET_ORG_KEY);
}
function setSourceOrg(ctx, alias) {
    return ctx.workspaceState.update(SOURCE_ORG_KEY, alias);
}
function setTargetOrg(ctx, alias) {
    return ctx.workspaceState.update(TARGET_ORG_KEY, alias);
}
/** Absolute path to the DM base directory (always inside .git/, never committed). */
function dmBaseDir(workspaceRoot) {
    return path.join(workspaceRoot, ".git", "sf-devops-dm");
}
/** Ensures the DM directory tree exists. Call before any file write. */
function ensureDmDirs(workspaceRoot, seedDir) {
    const base = dmBaseDir(workspaceRoot);
    for (const dir of [
        base,
        path.join(base, "tracking"),
        path.join(base, "history"),
        path.join(base, "dryrun", "seed"),
        path.resolve(workspaceRoot, seedDir),
    ]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
/** Safe filename derived from an org alias (strips special chars). */
function safeOrgName(alias) {
    return alias.replace(/[^a-zA-Z0-9_\-]/g, "_");
}
/** Path to the per-org tracking file. */
function trackingFilePath(workspaceRoot, orgAlias) {
    return path.join(dmBaseDir(workspaceRoot), "tracking", `${safeOrgName(orgAlias)}.json`);
}
function readTracking(workspaceRoot, orgAlias) {
    const fp = trackingFilePath(workspaceRoot, orgAlias);
    try {
        return JSON.parse(fs.readFileSync(fp, "utf-8"));
    }
    catch {
        return {};
    }
}
function writeTracking(workspaceRoot, orgAlias, data) {
    const fp = trackingFilePath(workspaceRoot, orgAlias);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
}
function appendHistoryEntry(workspaceRoot, entry) {
    const date = new Date().toISOString().slice(0, 10);
    const histDir = path.join(dmBaseDir(workspaceRoot), "history");
    fs.mkdirSync(histDir, { recursive: true });
    const fp = path.join(histDir, `${date}.jsonl`);
    fs.appendFileSync(fp, JSON.stringify(entry) + "\n", "utf-8");
}
function writeLastRunLog(workspaceRoot, lines) {
    const fp = path.join(dmBaseDir(workspaceRoot), "lastrun.log");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, lines.join("\n"), "utf-8");
}
function lastRunLogPath(workspaceRoot) {
    return path.join(dmBaseDir(workspaceRoot), "lastrun.log");
}
function pullLogsDir(workspaceRoot) {
    return path.join(dmBaseDir(workspaceRoot), "logs", "pull");
}
function loadLogsDir(workspaceRoot, orgAlias) {
    return path.join(dmBaseDir(workspaceRoot), "logs", "load", safeOrgName(orgAlias));
}
/** Write a timestamped log file; trims directory to the last 10 logs. */
function writeJobLog(dir, lines) {
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fp = path.join(dir, `${ts}.log`);
    fs.writeFileSync(fp, lines.join("\n"), "utf-8");
    const all = fs.readdirSync(dir).filter(f => f.endsWith(".log")).sort();
    while (all.length > 10) {
        try {
            fs.unlinkSync(path.join(dir, all.shift()));
        }
        catch { /* ignore */ }
    }
    return fp;
}
/** Return up to `max` recent log filenames (most-recent first). */
function listRecentLogs(dir, max = 5) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir).filter(f => f.endsWith(".log")).sort().reverse().slice(0, max);
}
//# sourceMappingURL=DataMigrationConfig.js.map