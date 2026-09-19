function makeUri(fsPath) {
    return {
        fsPath,
        with(changes) { return makeUri(fsPath); },
        toString: () => "file://" + fsPath,
    };
}

/** Parses "scheme:path?query" the way vscode.Uri.parse does — enough for content providers
 * (which read .scheme/.path/.query) to be tested against real-shaped URIs. */
function parseUri(s) {
    const schemeSplit = s.indexOf(":");
    const scheme = schemeSplit !== -1 ? s.slice(0, schemeSplit) : "";
    const rest = schemeSplit !== -1 ? s.slice(schemeSplit + 1) : s;
    const qIdx = rest.indexOf("?");
    const path = qIdx !== -1 ? rest.slice(0, qIdx) : rest;
    const query = qIdx !== -1 ? rest.slice(qIdx + 1) : "";
    return {
        scheme, path, query,
        fsPath: path,
        with(changes) { return { ...this, ...changes }; },
        toString: () => s,
    };
}

module.exports = {
    Uri: { joinPath: () => makeUri(""), file: (p) => makeUri(p), parse: (s) => parseUri(s) },
    window: {
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showQuickPick: async () => undefined,
        showInputBox: async () => undefined,
        createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
        createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {} }),
        createTerminal: () => ({ show: () => {}, sendText: () => {} }),
    },
    commands: { executeCommand: async () => undefined },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    extensions: { getExtension: () => undefined },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 1 },
    EventEmitter: class { event = () => {}; fire() {} },
    Disposable: class { constructor(fn) { this._fn = fn; } dispose() { if (this._fn) this._fn(); } },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};
