// End-to-end smoke test for the PRODUCTION bundle.
//
// Loads dist/extension.js with a stub `vscode` module, calls activate(), and
// lets it scan this machine's real session files. This is the highest-value
// check in the project: it catches activation crashes, externals that were not
// bundled, and watcher startup failures — none of which the unit tests can see,
// because they exercise the vscode-free modules only.
//
//   npm run bundle
//   node tools/smoke.js "D:\\SomeWorkspaceFolder"
//
// The argument is the workspace folder to pretend is open. Omit it to use cwd.

const Module = require("node:module");
const path = require("node:path");

const log = [];
const disposables = [];
const commands = new Map();
let statusText = null;
let statusTooltip = null;
let cockpitData = null;

function disposable() {
  const d = { dispose() {} };
  disposables.push(d);
  return d;
}

// Mirrors the defaults in package.json's `contributes.configuration`.
const CONFIG = {
  adapters: ["claude-code", "codex"],
  warningThreshold: 75,
  criticalThreshold: 90,
  quotaWarningThreshold: 80,
  quotaCriticalThreshold: 95,
  outputDir: ".ai-memory",
};

const vscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.argv[2] || process.cwd() } }],
    getConfiguration: () => ({
      get: (key, dflt) => (key in CONFIG ? CONFIG[key] : dflt),
    }),
    onDidChangeConfiguration: () => disposable(),
    onDidChangeWorkspaceFolders: () => disposable(),
    openTextDocument: async (p) => ({ uri: p }),
  },
  window: {
    createOutputChannel: (name) => ({
      appendLine: (l) => log.push(l),
      show() {},
      dispose() {},
      name,
    }),
    createStatusBarItem: () => ({
      show() {},
      dispose() {},
      set text(v) { statusText = v; },
      get text() { return statusText; },
      set tooltip(v) { statusTooltip = v; },
      get tooltip() { return statusTooltip; },
      command: undefined,
      backgroundColor: undefined,
    }),
    showInformationMessage: async (m) => { log.push("INFO " + m); return undefined; },
    showWarningMessage: async (m) => { log.push("WARN " + m); return undefined; },
    showErrorMessage: async (m) => { log.push("ERROR " + m); return undefined; },
    showQuickPick: async () => undefined,
    showTextDocument: async () => ({}),
    registerWebviewViewProvider: (id, provider) => {
      // capture what the cockpit would have been sent
      const original = provider.update && provider.update.bind(provider);
      if (original) {
        provider.update = (d) => { cockpitData = d; original(d); };
      }
      return disposable();
    },
    createWebviewPanel: () => ({
      reveal() {},
      onDidDispose() {},
      webview: { html: "", postMessage() {}, onDidReceiveMessage() {} },
    }),
    withProgress: (_opts, task) =>
      task({ report() {} }, { isCancellationRequested: false }),
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return disposable(); },
    executeCommand: async (id, ...a) =>
      (commands.has(id) ? commands.get(id)(...a) : undefined),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Window: 10, Notification: 15 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: { file: (f) => ({ fsPath: f }) },
};

// Make `require("vscode")` resolve to the stub above.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode";
  return origResolve.call(this, request, ...rest);
};
require.cache["vscode"] = {
  id: "vscode",
  filename: "vscode",
  loaded: true,
  exports: vscode,
};

const bundle = path.resolve(__dirname, "..", "dist", "extension.js");
const ext = require(bundle);

(async () => {
  const context = { subscriptions: [] };

  const t0 = Date.now();
  ext.activate(context);
  const activateMs = Date.now() - t0;

  // The startup scan is deferred onto a setTimeout(0); give it room to finish.
  await new Promise((r) => setTimeout(r, 6000));

  console.log("activate() returned in", activateMs, "ms");
  console.log("commands registered:", [...commands.keys()].join(", "));
  console.log("status bar text  :", statusText);
  console.log(
    "cockpit source   :",
    cockpitData && cockpitData.source,
    "| model:",
    cockpitData && cockpitData.model
  );
  console.log(
    "cockpit pct      :",
    cockpitData && cockpitData.percentUsed,
    "of",
    cockpitData && cockpitData.modelLimit
  );

  // Dashboard collection against real files: cold, then warm.
  const t1 = Date.now();
  await commands.get("contextControl.dashboard")();
  console.log("dashboard scan   :", Date.now() - t1, "ms (cold)");
  const t2 = Date.now();
  await commands.get("contextControl.dashboard")();
  console.log("dashboard scan   :", Date.now() - t2, "ms (warm, cached)");

  // The incremental path: repeated rescans must be nearly free.
  const t3 = Date.now();
  for (let i = 0; i < 20; i++) {
    await commands.get("contextControl.scan")();
  }
  console.log("20 rescans       :", Date.now() - t3, "ms total");

  console.log("\n--- output channel ---");
  console.log(log.join("\n"));

  for (const d of context.subscriptions) {
    if (d.dispose) d.dispose();
  }
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
