"use strict";
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
exports.getEffectiveRole = getEffectiveRole;
exports.isAdmin = isAdmin;
exports.canAccessConfig = canAccessConfig;
exports.hasRolePassword = hasRolePassword;
exports.setRolePassword = setRolePassword;
exports.migrateRolePasswordIfNeeded = migrateRolePasswordIfNeeded;
exports.promptChangeRole = promptChangeRole;
exports.resetRolePassword = resetRolePassword;
exports.resetRolePasswordForce = resetRolePasswordForce;
const vscode = __importStar(require("vscode"));
const crypto = __importStar(require("crypto"));
const config_1 = require("./config");
const ROLE_STATE_KEY = "sfDevops.effectiveRole";
const LEGACY_ROLE_PASSWORD_SECRET = "sfDevops.rolePasswordHash"; // migration only — do not use for new reads/writes
const ELEVATED_ROLES = new Set(["Lead", "Admin", "Data Load"]);
function rolePasswordKey(role) {
    return `sfDevops.rolePassword.${role}`;
}
/** The role in effect for this person on this machine — global, not per-workspace (role is about the person, not the repo). */
function getEffectiveRole(context) {
    return context.globalState.get(ROLE_STATE_KEY) || (0, config_1.getCurrentRole)();
}
function isAdmin(role) {
    return role === "Admin";
}
/** Gates config/setup-management UI (org alias editing, opening Settings via this extension's own buttons) to Admins only. */
function canAccessConfig(role) {
    return isAdmin(role);
}
function hashPassword(password) {
    return crypto.createHash("sha256").update(password).digest("hex");
}
async function hasRolePassword(context, targetRole) {
    return Boolean(await context.secrets.get(rolePasswordKey(targetRole)));
}
async function setRolePassword(context, password, targetRole) {
    await context.secrets.store(rolePasswordKey(targetRole), hashPassword(password));
}
async function verifyRolePassword(context, password, targetRole) {
    const stored = await context.secrets.get(rolePasswordKey(targetRole));
    return Boolean(stored) && stored === hashPassword(password);
}
/**
 * One-time migration: if the pre-Plan-1 single ROLE_PASSWORD_SECRET exists, copy it to
 * the Admin slot (highest privilege) and delete the old key. Idempotent — safe to call
 * on every activation.
 */
async function migrateRolePasswordIfNeeded(context) {
    const legacy = await context.secrets.get(LEGACY_ROLE_PASSWORD_SECRET);
    if (!legacy) {
        return;
    }
    const adminKey = rolePasswordKey("Admin");
    const adminAlreadySet = await context.secrets.get(adminKey);
    if (!adminAlreadySet) {
        await context.secrets.store(adminKey, legacy);
    }
    await context.secrets.delete(LEGACY_ROLE_PASSWORD_SECRET);
}
/**
 * Prompts to change role, password-gating Lead/Admin. If no password has ever been set,
 * the first elevation attempt prompts to set one on the spot (never hardcoded in source —
 * that would ship a readable literal inside the .vsix). Returns true if the role actually changed.
 */
async function promptChangeRole(context, roles, gitHelper) {
    const current = getEffectiveRole(context);
    const picked = await vscode.window.showQuickPick(roles, {
        title: "Change Role",
        placeHolder: `Current role: ${current}`,
    });
    if (!picked || picked === current) {
        return false;
    }
    if (ELEVATED_ROLES.has(picked)) {
        const alreadySet = await hasRolePassword(context, picked);
        if (!alreadySet) {
            const newPassword = await vscode.window.showInputBox({
                prompt: `No role-change password is set yet for "${picked}" — set one now (you'll use it for future elevations to this role)`,
                password: true,
                ignoreFocusOut: true,
                validateInput: v => v.trim().length > 0 ? undefined : "Password cannot be empty",
            });
            if (!newPassword) {
                return false;
            }
            await setRolePassword(context, newPassword, picked);
        }
        else {
            const entered = await vscode.window.showInputBox({
                prompt: `Enter the "${picked}" role password`,
                password: true,
                ignoreFocusOut: true,
            });
            if (!entered) {
                return false;
            }
            if (!(await verifyRolePassword(context, entered, picked))) {
                vscode.window.showErrorMessage("Incorrect password — role not changed.");
                return false;
            }
        }
    }
    await context.globalState.update(ROLE_STATE_KEY, picked);
    if (gitHelper) {
        await gitHelper.appendAudit({
            operation: "changeRole",
            outcome: "success",
            summary: `Role changed from ${current} to ${picked}`,
        });
    }
    vscode.window.showInformationMessage(`Role changed to ${picked}.`);
    return true;
}
/**
 * Admin-only: prompts for the current Admin password to confirm, then lets the Admin
 * set a new password for any elevated role (Lead or Admin). Command Palette only.
 */
async function resetRolePassword(context, gitHelper) {
    const currentRole = getEffectiveRole(context);
    if (currentRole !== "Admin") {
        vscode.window.showWarningMessage("Only Admins can reset role passwords.");
        return;
    }
    const adminConfirm = await vscode.window.showInputBox({
        prompt: "Enter your current Admin password to confirm",
        password: true,
        ignoreFocusOut: true,
    });
    if (!adminConfirm) {
        return;
    }
    if (!(await verifyRolePassword(context, adminConfirm, "Admin"))) {
        vscode.window.showErrorMessage("Incorrect Admin password — reset cancelled.");
        return;
    }
    const targetRole = await vscode.window.showQuickPick(["Lead", "Admin"], {
        title: "Reset password for which role?",
        placeHolder: "Select a role",
    });
    if (!targetRole) {
        return;
    }
    const newPassword = await vscode.window.showInputBox({
        prompt: `Set new password for "${targetRole}" role`,
        password: true,
        ignoreFocusOut: true,
        validateInput: v => v.trim().length > 0 ? undefined : "Password cannot be empty",
    });
    if (!newPassword) {
        return;
    }
    await setRolePassword(context, newPassword, targetRole);
    if (gitHelper) {
        await gitHelper.appendAudit({
            operation: "changeRole",
            outcome: "success",
            summary: `Admin reset the "${targetRole}" role password`,
        });
    }
    vscode.window.showInformationMessage(`✅ "${targetRole}" role password updated.`);
}
/**
 * Break-glass: clears ALL role passwords and resets effective role to Developer.
 * No password required — protected by typing "RESET" to confirm.
 * Command Palette only — intentionally buried.
 */
async function resetRolePasswordForce(context, gitHelper) {
    const confirm = await vscode.window.showWarningMessage("⚠ BREAK-GLASS: This will clear ALL role passwords and reset everyone on this machine to Developer. There is no undo.", { modal: true }, "Continue to confirmation");
    if (!confirm) {
        return;
    }
    const typed = await vscode.window.showInputBox({
        prompt: 'Type RESET (all caps) to confirm — this cannot be undone',
        ignoreFocusOut: true,
        validateInput: v => v === "RESET" ? undefined : 'Type exactly "RESET" to proceed',
    });
    if (typed !== "RESET") {
        return;
    }
    await context.secrets.delete(rolePasswordKey("Lead"));
    await context.secrets.delete(rolePasswordKey("Admin"));
    await context.secrets.delete(rolePasswordKey("Data Load"));
    await context.globalState.update(ROLE_STATE_KEY, "Developer");
    if (gitHelper) {
        await gitHelper.appendAudit({
            operation: "changeRole",
            outcome: "success",
            summary: "All role passwords cleared via break-glass reset — role reset to Developer",
        });
    }
    vscode.window.showInformationMessage("✅ All role passwords cleared. Role reset to Developer.");
}
//# sourceMappingURL=RoleManager.js.map