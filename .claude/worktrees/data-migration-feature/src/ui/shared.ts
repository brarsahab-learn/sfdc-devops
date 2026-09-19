// shared.ts — VS Code-native CSS utilities shared by all webview panels.
import * as vscode from "vscode";

/**
 * Returns a Content-Security-Policy <meta> tag appropriate for an inline-script webview panel.
 * Blocks all external network requests; allows only inline styles and inline scripts.
 */
export function cspMeta(webview: vscode.Webview): string {
    const src = webview.cspSource;
    return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${src}; script-src 'unsafe-inline' ${src}; img-src data: ${src};">`;
}

/**
 * Shared base CSS that uses VS Code CSS custom properties correctly.
 * Panels should append their own panel-specific CSS after this.
 */
export function sharedCss(): string {
    return `
*, *::before, *::after { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: 20px 24px 60px;
  line-height: 1.5;
}
h1 { font-size: 18px; font-weight: 600; margin: 0 0 16px; }
h2 {
  font-size: 11px; font-weight: 600; margin: 24px 0 8px;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase; letter-spacing: 0.06em;
  border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px;
}
h3 { font-size: 13px; font-weight: 600; margin: 0 0 6px; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.9em;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
  padding: 1px 5px; border-radius: 3px;
}
.toolbar { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }

/* ── Buttons ── */
.btn {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--vscode-font-family); font-size: 12px;
  padding: 4px 12px; border-radius: 3px; cursor: pointer;
  border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  white-space: nowrap; transition: opacity 0.1s;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}
.btn-primary:hover { background: var(--vscode-button-hoverBackground); border-color: var(--vscode-button-hoverBackground); }
.btn-danger {
  background: transparent;
  color: var(--vscode-errorForeground, #f44747);
  border-color: var(--vscode-errorForeground, #f44747);
}
.btn-danger:hover { background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 10%, transparent); }
.btn-sm { font-size: 11px; padding: 2px 8px; }
.btn-icon { padding: 4px 7px; font-size: 14px; }

/* ── Inputs ── */
input[type=text], input[type=search], input[type=number], select, textarea {
  font-family: var(--vscode-font-family); font-size: 12px;
  padding: 4px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 3px; outline: none;
}
input:focus, select:focus { border-color: var(--vscode-focusBorder); }

/* ── Cards / panels ── */
.card {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px; padding: 12px 16px; margin-bottom: 10px;
}
.card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }

/* ── Banners ── */
.banner {
  border-radius: 4px; padding: 8px 12px; margin-bottom: 12px;
  font-size: 12px; display: flex; align-items: center; gap: 8px;
}
.banner-ok   { background: color-mix(in srgb, var(--vscode-charts-green,  #4caf50) 12%, var(--vscode-editor-background)); border: 1px solid var(--vscode-charts-green,  #4caf50); color: var(--vscode-charts-green,  #4caf50); }
.banner-warn { background: color-mix(in srgb, var(--vscode-charts-yellow, #e6a817) 12%, var(--vscode-editor-background)); border: 1px solid var(--vscode-charts-yellow, #e6a817); color: var(--vscode-notificationsWarningIcon-foreground, #e6a817); }
.banner-err  { background: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 12%, var(--vscode-editor-background)); border: 1px solid var(--vscode-errorForeground, #f44747); color: var(--vscode-errorForeground, #f44747); }
.banner-info { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); color: var(--vscode-foreground); }

/* ── Lists ── */
.item-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
.item-list li { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
.item-list li:last-child { border-bottom: none; }
.item-list li:hover { background: var(--vscode-list-hoverBackground); }

/* ── Badges ── */
.badge { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 10px; display: inline-block; white-space: nowrap; }
.badge-green  { background: var(--vscode-charts-green,  #4caf50); color: #fff; }
.badge-red    { background: var(--vscode-charts-red,    #f44747); color: #fff; }
.badge-blue   { background: var(--vscode-charts-blue,   #1976d2); color: #fff; }
.badge-yellow { background: var(--vscode-charts-yellow, #e6a817); color: #000; }
.badge-gray   { background: var(--vscode-panel-border);            color: var(--vscode-foreground); }

/* ── Loading skeleton ── */
.skeleton { height: 14px; border-radius: 3px; background: var(--vscode-panel-border); animation: pulse 1.4s ease-in-out infinite; margin-bottom: 8px; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

/* ── Misc ── */
.muted { color: var(--vscode-descriptionForeground); }
.mono  { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
.row   { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }
.nowrap { white-space: nowrap; }
`;
}

/**
 * Standard animated loading page that correctly inherits VS Code theme.
 */
export function loadingHtml(title = "Loading…"): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family, -apple-system, sans-serif); padding: 32px 24px; color: var(--vscode-descriptionForeground, #888); background: var(--vscode-editor-background); margin: 0; }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--vscode-panel-border, #444); border-top-color: var(--vscode-button-background, #0078d4); border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sk { height: 12px; border-radius: 3px; background: var(--vscode-panel-border, #333); animation: pulse 1.4s ease-in-out infinite; margin-bottom: 8px; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
</style>
</head>
<body>
<div class="row"><div class="spinner"></div><span>${title}</span></div>
<div class="sk" style="width:65%"></div>
<div class="sk" style="width:80%"></div>
<div class="sk" style="width:50%"></div>
</body>
</html>`;
}
