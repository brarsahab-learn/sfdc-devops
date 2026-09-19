import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface DmObjectConfig {
	id: string;
	sobject: string;
	label?: string;
	query: string;
	active: boolean;
	order: number;
	dependsOn?: string[];
	externalIdField?: string;
	externalIdVerified?: boolean;
}

export interface DmConfig {
	objects: DmObjectConfig[];
	seedDir: string;
	batchSize: number;
	autoCreateExternalId: boolean;
}

const DEFAULT_CONFIG: DmConfig = {
	objects: [],
	seedDir: ".git/sf-devops-dm/seed",
	batchSize: 190,
	autoCreateExternalId: true
};

export function readDmConfig(workspaceRoot: string): DmConfig {
	try {
		const configPath = path.join(workspaceRoot, ".sf-devops-dm.json");
		const content = fs.readFileSync(configPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return DEFAULT_CONFIG;
	}
}

export function writeDmConfig(workspaceRoot: string, config: DmConfig): void {
	const configPath = path.join(workspaceRoot, ".sf-devops-dm.json");
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function getSourceOrg(ctx: vscode.ExtensionContext): string | undefined {
	return ctx.workspaceState.get<string>("sfDevops.dm.sourceOrg");
}

export function getTargetOrg(ctx: vscode.ExtensionContext): string | undefined {
	return ctx.workspaceState.get<string>("sfDevops.dm.targetOrg");
}

export function setSourceOrg(ctx: vscode.ExtensionContext, alias: string): Thenable<void> {
	return ctx.workspaceState.update("sfDevops.dm.sourceOrg", alias);
}

export function setTargetOrg(ctx: vscode.ExtensionContext, alias: string): Thenable<void> {
	return ctx.workspaceState.update("sfDevops.dm.targetOrg", alias);
}