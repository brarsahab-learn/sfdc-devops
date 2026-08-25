// RoleManager.ts — the effective Developer/Lead/Admin role for THIS person, plus a
// password-gated flow for elevating to Lead/Admin.
//
// IMPORTANT — this is a soft, client-side deterrent, not a hard security boundary.
// A VS Code extension cannot lock a determined local user out of their own machine's
// storage. What this DOES do: stop a one-click settings.json edit (the old
// sfDevops.role setting was freely editable by anyone) by moving the effective role
// out of a plain setting and behind a password prompt. The real hard boundary for
// Prod safety is org credentials — only authenticate Prod's org alias on machines
// belonging to people who should actually be able to deploy there.

import * as vscode from "vscode";
import * as crypto from "crypto";
import { getCurrentRole as getLegacyRoleSetting } from "./config";

const ROLE_STATE_KEY      = "sfDevops.effectiveRole";
const ROLE_PASSWORD_SECRET = "sfDevops.rolePasswordHash";
const ELEVATED_ROLES = new Set(["Lead", "Admin"]);

/** The role in effect for this person on this machine — global, not per-workspace (role is about the person, not the repo). */
export function getEffectiveRole(context: vscode.ExtensionContext): string {
    return context.globalState.get<string>(ROLE_STATE_KEY) || getLegacyRoleSetting();
}

export function isAdmin(role: string): boolean {
    return role === "Admin";
}

/** Gates config/setup-management UI (org alias editing, opening Settings via this extension's own buttons) to Admins only. */
export function canAccessConfig(role: string): boolean {
    return isAdmin(role);
}

function hashPassword(password: string): string {
    return crypto.createHash("sha256").update(password).digest("hex");
}

export async function hasRolePassword(context: vscode.ExtensionContext): Promise<boolean> {
    return Boolean(await context.secrets.get(ROLE_PASSWORD_SECRET));
}

export async function setRolePassword(context: vscode.ExtensionContext, password: string): Promise<void> {
    await context.secrets.store(ROLE_PASSWORD_SECRET, hashPassword(password));
}

async function verifyRolePassword(context: vscode.ExtensionContext, password: string): Promise<boolean> {
    const stored = await context.secrets.get(ROLE_PASSWORD_SECRET);
    return Boolean(stored) && stored === hashPassword(password);
}

/**
 * Prompts to change role, password-gating Lead/Admin. If no password has ever been set,
 * the first elevation attempt prompts to set one on the spot (never hardcoded in source —
 * that would ship a readable literal inside the .vsix). Returns true if the role actually changed.
 */
export async function promptChangeRole(context: vscode.ExtensionContext, roles: string[]): Promise<boolean> {
    const current = getEffectiveRole(context);
    const picked = await vscode.window.showQuickPick(roles, {
        title: "Change Role",
        placeHolder: `Current role: ${current}`,
    });
    if (!picked || picked === current) { return false; }

    if (ELEVATED_ROLES.has(picked)) {
        const alreadySet = await hasRolePassword(context);
        if (!alreadySet) {
            const newPassword = await vscode.window.showInputBox({
                prompt: `No role-change password is set yet — set one now to become "${picked}" (you'll use it for future elevations too)`,
                password: true,
                ignoreFocusOut: true,
                validateInput: v => v.trim().length > 0 ? undefined : "Password cannot be empty",
            });
            if (!newPassword) { return false; }
            await setRolePassword(context, newPassword);
        } else {
            const entered = await vscode.window.showInputBox({
                prompt: `Enter the role-change password to become "${picked}"`,
                password: true,
                ignoreFocusOut: true,
            });
            if (!entered) { return false; }
            if (!(await verifyRolePassword(context, entered))) {
                vscode.window.showErrorMessage("Incorrect password — role not changed.");
                return false;
            }
        }
    }

    await context.globalState.update(ROLE_STATE_KEY, picked);
    vscode.window.showInformationMessage(`Role changed to ${picked}.`);
    return true;
}
