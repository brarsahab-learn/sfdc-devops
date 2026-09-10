// DataMigrationConfig.ts — read/write the .sf-devops-dm.json config and org-selection state.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface DmObjectConfig {
    id:               string;
    sobject:          string;
    label?:           string;
    query:            string;
    active:           boolean;
    order:            number;
    dependsOn?:       string[];
    externalIdField?: string;
}

export interface DmConfig {
    objects:   DmObjectConfig[];
    seedDir:   string;
    batchSize: number;
    // Opt-in: before a load, upsert a per-running-user override of the DataMigrationControls__c
    // hierarchy custom setting (all automation-disabling fields set true) so triggers/flows/
    // validation rules don't fire during the bulk upsert; restored to whatever it was — or
    // deleted, if we created it — once the load ends (success, failure, or cancel).
    disableAutomationDuringLoad?: boolean;
}

const CONFIG_FILE = ".sf-devops-dm.json";
const SOURCE_ORG_KEY = "sfDevops.dm.sourceOrg";
const TARGET_ORG_KEY = "sfDevops.dm.targetOrg";

const DEFAULT_CONFIG: DmConfig = {
    objects:   [],
    seedDir:   ".git/sf-devops-dm/seed",
    batchSize: 190,
};

export function readDmConfig(workspaceRoot: string): DmConfig {
    const filePath = path.join(workspaceRoot, CONFIG_FILE);
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<DmConfig>;
        return {
            objects:   parsed.objects   ?? [],
            seedDir:   parsed.seedDir   ?? DEFAULT_CONFIG.seedDir,
            batchSize: parsed.batchSize ?? 190,
            disableAutomationDuringLoad: parsed.disableAutomationDuringLoad ?? false,
        };
    } catch {
        return { ...DEFAULT_CONFIG, objects: [] };
    }
}

export function writeDmConfig(workspaceRoot: string, config: DmConfig): void {
    const filePath = path.join(workspaceRoot, CONFIG_FILE);
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

export function getSourceOrg(ctx: vscode.ExtensionContext): string | undefined {
    return ctx.workspaceState.get<string>(SOURCE_ORG_KEY);
}

export function getTargetOrg(ctx: vscode.ExtensionContext): string | undefined {
    return ctx.workspaceState.get<string>(TARGET_ORG_KEY);
}

export function setSourceOrg(ctx: vscode.ExtensionContext, alias: string): Thenable<void> {
    return ctx.workspaceState.update(SOURCE_ORG_KEY, alias);
}

export function setTargetOrg(ctx: vscode.ExtensionContext, alias: string): Thenable<void> {
    return ctx.workspaceState.update(TARGET_ORG_KEY, alias);
}

/** Absolute path to the DM base directory (always inside .git/, never committed). */
export function dmBaseDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".git", "sf-devops-dm");
}

/** Ensures the DM directory tree exists. Call before any file write. */
export function ensureDmDirs(workspaceRoot: string, seedDir: string): void {
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
export function safeOrgName(alias: string): string {
    return alias.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

/** Path to the per-org tracking file. */
export function trackingFilePath(workspaceRoot: string, orgAlias: string): string {
    return path.join(dmBaseDir(workspaceRoot), "tracking", `${safeOrgName(orgAlias)}.json`);
}

export type TrackingStatus = "pending" | "created" | "failed" | "skipped" | "blocked" | "deleted" | "delete-failed";

export interface TrackingEntry {
    status:   TrackingStatus;
    id?:      string;
    error?:   string;
    at:       string;
}

export type ObjectTracking = Record<string, TrackingEntry>;
export type TrackingFile   = Record<string, ObjectTracking>;

export function readTracking(workspaceRoot: string, orgAlias: string): TrackingFile {
    const fp = trackingFilePath(workspaceRoot, orgAlias);
    try {
        return JSON.parse(fs.readFileSync(fp, "utf-8")) as TrackingFile;
    } catch {
        return {};
    }
}

export function writeTracking(workspaceRoot: string, orgAlias: string, data: TrackingFile): void {
    const fp = trackingFilePath(workspaceRoot, orgAlias);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
}

export function appendHistoryEntry(workspaceRoot: string, entry: object): void {
    const date = new Date().toISOString().slice(0, 10);
    const histDir = path.join(dmBaseDir(workspaceRoot), "history");
    fs.mkdirSync(histDir, { recursive: true });
    const fp = path.join(histDir, `${date}.jsonl`);
    fs.appendFileSync(fp, JSON.stringify(entry) + "\n", "utf-8");
}

export function writeLastRunLog(workspaceRoot: string, lines: string[]): void {
    const fp = path.join(dmBaseDir(workspaceRoot), "lastrun.log");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, lines.join("\n"), "utf-8");
}

export function lastRunLogPath(workspaceRoot: string): string {
    return path.join(dmBaseDir(workspaceRoot), "lastrun.log");
}

export function pullLogsDir(workspaceRoot: string): string {
    return path.join(dmBaseDir(workspaceRoot), "logs", "pull");
}

export function loadLogsDir(workspaceRoot: string, orgAlias: string): string {
    return path.join(dmBaseDir(workspaceRoot), "logs", "load", safeOrgName(orgAlias));
}

/** Write a timestamped log file; trims directory to the last 10 logs. */
export function writeJobLog(dir: string, lines: string[]): string {
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fp = path.join(dir, `${ts}.log`);
    fs.writeFileSync(fp, lines.join("\n"), "utf-8");
    const all = fs.readdirSync(dir).filter(f => f.endsWith(".log")).sort();
    while (all.length > 10) { try { fs.unlinkSync(path.join(dir, all.shift()!)); } catch { /* ignore */ } }
    return fp;
}

/** Return up to `max` recent log filenames (most-recent first). */
export function listRecentLogs(dir: string, max = 5): string[] {
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir).filter(f => f.endsWith(".log")).sort().reverse().slice(0, max);
}
