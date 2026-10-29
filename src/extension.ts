import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ClaudeCodeAdapter } from "./adapters/claudeCode";
import { ClineAdapter } from "./adapters/cline";
import { CodexAdapter } from "./adapters/codex";
import type { BaseAdapter } from "./adapters/base";
import { FileWatcher } from "./watcher/fileWatcher";
import { Analyzer } from "./core/analyzer";
import { StatusBar } from "./ui/statusBar";
import { Notifications } from "./ui/notifications";
import { Dashboard, type SessionSummary } from "./ui/dashboard";
import { Cockpit } from "./ui/cockpit";
import { HandoffGenerator } from "./handoff/ruleBased";
import { MarkdownExporter } from "./exporters/markdown";
import { modelLimitFromMessages } from "./core/modelLimits";
import { FileStatCache, type FileFingerprint } from "./core/fileStatCache";
import { initLog, log, logError, showLog, disposeLog } from "./core/log";
import type { ContextStats, NormalizedMessage, RateLimitWindow, Source } from "./core/types";

/** Cap how many sessions the dashboard parses, to bound a full scan. */
const DASHBOARD_SESSION_LIMIT = 50;

/** Settings that change what we watch or parse, and so need a rebuild. */
const REBUILD_KEYS = ["contextControl.adapters"];

interface SessionCandidate {
  adapter: BaseAdapter;
  file: string;
  fingerprint: FileFingerprint;
}

interface LocatedSession {
  adapter: BaseAdapter;
  file: string;
  messages: NormalizedMessage[];
  mtime: number;
  /** Open workspace folder whose scoped lookup produced this session. */
  workspaceRoot?: string;
}

type ContextControlMenuCommand =
  | "cockpit"
  | "dashboard"
  | "handoff"
  | "logs"
  | "scan"
  | "status";

interface ContextControlMenuItem extends vscode.QuickPickItem {
  command: ContextControlMenuCommand;
}

async function fileMtime(file: string): Promise<number> {
  try {
    return (await fs.promises.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function fileFingerprint(file: string): Promise<FileFingerprint | undefined> {
  try {
    const stat = await fs.promises.stat(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

/** Yield to the event loop so a long scan never freezes the extension host. */
function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Current alert thresholds, shared with the webviews so bars agree with alerts. */
export interface Thresholds {
  warning: number;
  critical: number;
  quotaWarning: number;
  quotaCritical: number;
}

function readThresholds(): Thresholds {
  const cfg = vscode.workspace.getConfiguration("contextControl");
  return {
    warning: cfg.get<number>("warningThreshold", 75),
    critical: cfg.get<number>("criticalThreshold", 90),
    quotaWarning: cfg.get<number>("quotaWarningThreshold", 80),
    quotaCritical: cfg.get<number>("quotaCriticalThreshold", 95),
  };
}

function quotaStatus(stats: ContextStats): string {
  const limits = stats.rateLimits;
  if (!limits || (!limits.primary && !limits.secondary)) {
    return "quota: not reported.";
  }
  const plan = limits.planType ? `${titleCase(limits.planType)} plan` : "provider quota";
  const parts: string[] = [];
  if (limits.primary) {
    parts.push(`primary ${quotaWindowStatus(limits.primary)}`);
  }
  if (limits.secondary) {
    parts.push(`secondary ${quotaWindowStatus(limits.secondary)}`);
  }
  return `${plan}: ${parts.join(", ")}.`;
}

function quotaWindowStatus(window: RateLimitWindow): string {
  return `${Math.round(window.usedPercent)}% / ${quotaWindowLabel(window.windowMinutes)}`;
}

function quotaWindowLabel(minutes: number): string {
  if (minutes >= 10080 && minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? "7d weekly" : `${weeks}w`;
  }
  if (minutes >= 1440 && minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "1d" : `${days}d`;
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 5 ? "5h session" : `${hours}h`;
  }
  if (minutes > 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${m}m`;
  }
  return `${minutes}m`;
}

function titleCase(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value;
}

function modelsFromMessages(messages: NormalizedMessage[]): string[] {
  const models: string[] = [];
  for (const message of messages) {
    const model = message.metadata?.model;
    if (model && model !== "<synthetic>" && models[models.length - 1] !== model) {
      models.push(model);
    }
  }
  return models;
}

export function activate(context: vscode.ExtensionContext): void {
  initLog();
  log("activating Context Control");

  // 1. init adapters (respecting the user's enabled list). Rebuilt in place
  // when the setting changes, so no window reload is needed.
  // Cline remains opt-in until its storage schema is verified against real data.
  const DEFAULT_ADAPTERS = ["claude-code", "codex"];
  function buildAdapters(): BaseAdapter[] {
    const enabled = vscode.workspace
      .getConfiguration("contextControl")
      .get<string[]>("adapters", DEFAULT_ADAPTERS);
    const all: BaseAdapter[] = [new ClaudeCodeAdapter(), new ClineAdapter(), new CodexAdapter()];
    return all.filter((a) => enabled.includes(a.name));
  }
  let adapters = buildAdapters();

  const analyzer = new Analyzer();
  const generator = new HandoffGenerator();
  const exporter = new MarkdownExporter();
  const summaryCache = new FileStatCache<SessionSummary | undefined>();

  // 2. init status bar + notifications + cockpit
  const statusBar = new StatusBar();
  const notifications = new Notifications();
  const cockpit = new Cockpit();

  // Shared state: the most recently analyzed session.
  let latest:
    | {
        messages: NormalizedMessage[];
        stats: ContextStats;
        source: Source;
        file: string;
        workspaceRoot?: string;
      }
    | undefined;

  // A scan can outlast the debounce that triggered it, so serialize: one runs
  // at a time and at most one more is queued behind it. Without this, a busy
  // session could stack overlapping parses on the extension host.
  let scanPromise: Promise<void> | undefined;
  let rescanQueued = false;

  /** Find the session for the open workspace (or newest) and analyze it. */
  async function scan(silent = false): Promise<void> {
    if (scanPromise) {
      rescanQueued = true;
      return scanPromise;
    }
    scanPromise = (async () => {
      try {
        let nextSilent = silent;
        do {
          rescanQueued = false;
          await runScan(nextSilent);
          nextSilent = true;
        } while (rescanQueued);
      } catch (err) {
        logError("scan failed", err);
        if (!silent) {
          void vscode.window.showErrorMessage(
            "Context Control: scan failed. Run 'Context Control: Show Logs' for details."
          );
        }
      } finally {
        scanPromise = undefined;
      }
    })();
    return scanPromise;
  }

  /** Every open workspace folder, or `[undefined]` when none is open. */
  function workspacePaths(): (string | undefined)[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [undefined];
    }
    return folders.map((f) => f.uri.fsPath);
  }

  /** The open folder containing the active editor, or the sole open folder. */
  function activeWorkspaceRoot(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 ? folders[0].uri.fsPath : undefined;
  }

  /** Resolve an unambiguous workspace for Generate Handoff in multi-root windows. */
  async function handoffWorkspaceRoot(): Promise<
    { cancelled: false; root?: string } | { cancelled: true }
  > {
    const active = activeWorkspaceRoot();
    if (active) {
      return { cancelled: false, root: active };
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) {
      return { cancelled: false, root: folders[0]?.uri.fsPath };
    }
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        root: folder.uri.fsPath,
      })),
      {
        placeHolder: "Choose the project whose conversation should be handed off",
        title: "Context Control: Select Project",
      }
    );
    return picked ? { cancelled: false, root: picked.root } : { cancelled: true };
  }

  /** Find the freshest provider session strictly inside the supplied folders. */
  async function findBestSession(
    roots: (string | undefined)[]
  ): Promise<LocatedSession | undefined> {
    let best: LocatedSession | undefined;

    for (const adapter of adapters) {
      const candidates = new Map<string, { mtime: number; workspaceRoot?: string }>();
      for (const workspaceRoot of roots) {
        let sessions: string[] = [];
        try {
          sessions = await adapter.listSessions(workspaceRoot);
        } catch (err) {
          logError(`${adapter.name} listSessions failed`, err);
          continue;
        }
        const file = sessions[0];
        if (file !== undefined && !candidates.has(file)) {
          candidates.set(file, { mtime: await fileMtime(file), workspaceRoot });
        }
      }
      if (candidates.size === 0) {
        continue;
      }
      const [file, located] = [...candidates.entries()].sort(
        (a, b) => b[1].mtime - a[1].mtime
      )[0];
      try {
        const messages = await adapter.parse(file);
        if (messages.length > 0 && (!best || located.mtime > best.mtime)) {
          best = { adapter, file, messages, ...located };
        }
      } catch (err) {
        logError(`${adapter.name} parse failed for ${file}`, err);
      }
    }
    return best;
  }

  async function runScan(silent: boolean): Promise<void> {
    const started = Date.now();
    const best = await findBestSession(workspacePaths());

    if (!best) {
      latest = undefined;
      log("scan: no conversations found");
      if (!silent) {
        void vscode.window.showInformationMessage(
          "Context Control: no conversations found to scan."
        );
      }
      return;
    }

    // Auto-detect the context window from the conversation's model (#3).
    const modelLimit = modelLimitFromMessages(best.messages);
    const stats = analyzer.analyze(best.messages, modelLimit);
    latest = {
      messages: best.messages,
      stats,
      source: best.adapter.name,
      file: best.file,
      workspaceRoot: best.workspaceRoot,
    };
    const models = modelsFromMessages(best.messages);
    statusBar.update(stats);
    cockpit.update({
      source: best.adapter.name,
      model: models[models.length - 1],
      percentUsed: stats.percentUsed,
      totalTokens: stats.totalTokens,
      modelLimit: stats.modelLimit,
      level: stats.level,
      tokensPerMessage: stats.tokensPerMessage,
      messagesUntilCritical: stats.messagesUntilCritical,
      estimatedCostUsd: stats.estimatedCostUsd,
      tokenSource: stats.tokenSource,
      rateLimits: stats.rateLimits,
      updatedAt: Date.now(),
    });
    await notifications.react(stats, best.file, best.adapter.name);
    log(
      `scan: ${best.adapter.name} ${stats.messagesCount} msgs, ` +
        `${stats.percentUsed}% of ${stats.modelLimit} in ${Date.now() - started}ms`
    );

    if (!silent) {
      void vscode.window.showInformationMessage(
        `Context Control: scanned ${stats.messagesCount} messages — ${stats.percentUsed}% used.`
      );
    }
  }

  /** Analyze one session file into a dashboard summary. */
  function summaryCacheKey(adapter: BaseAdapter, file: string): string {
    return `${adapter.name}\0${file}`;
  }

  async function summarize(
    adapter: BaseAdapter,
    file: string,
    fingerprint: FileFingerprint
  ): Promise<SessionSummary | undefined> {
    const key = summaryCacheKey(adapter, file);
    const cached = summaryCache.get(key, fingerprint);
    if (cached.hit) {
      return cached.value;
    }
    const messages = await adapter.parse(file);
    if (messages.length === 0) {
      summaryCache.set(key, fingerprint, undefined);
      return undefined;
    }
    const stats = analyzer.analyze(messages, modelLimitFromMessages(messages));
    const models = modelsFromMessages(messages);
    const summary: SessionSummary = {
      source: adapter.name,
      project: path.basename(path.dirname(file)),
      file,
      messages: stats.messagesCount,
      totalTokens: stats.totalTokens,
      modelLimit: stats.modelLimit,
      percentUsed: stats.percentUsed,
      level: stats.level,
      estimatedCostUsd: stats.estimatedCostUsd,
      tokenSource: stats.tokenSource,
      model: models[models.length - 1],
      models,
      rateLimits: stats.rateLimits,
      updatedAt: fingerprint.mtimeMs,
    };
    summaryCache.set(key, fingerprint, summary);
    return summary;
  }

  /**
   * Collect summaries for every (capped) session across enabled adapters.
   *
   * Parsing 50 sessions is seconds of work, so it yields to the event loop
   * between files and honours cancellation — the progress notification's
   * Cancel button actually stops it.
   */
  async function collectSummaries(token?: vscode.CancellationToken): Promise<SessionSummary[]> {
    const candidates: SessionCandidate[] = [];
    const out: SessionSummary[] = [];
    for (const adapter of adapters) {
      let sessions: string[] = [];
      try {
        sessions = await adapter.listSessions();
      } catch (err) {
        logError(`${adapter.name} listSessions failed`, err);
      }
      for (const file of sessions) {
        const fingerprint = await fileFingerprint(file);
        if (fingerprint) {
          candidates.push({ adapter, file, fingerprint });
        }
      }
    }

    candidates.sort((a, b) => b.fingerprint.mtimeMs - a.fingerprint.mtimeMs);
    const selected = candidates.slice(0, DASHBOARD_SESSION_LIMIT);
    summaryCache.prune(
      new Set(selected.map(({ adapter, file }) => summaryCacheKey(adapter, file)))
    );
    for (const { adapter, file, fingerprint } of selected) {
      if (token?.isCancellationRequested) {
        log(`dashboard: scan cancelled after ${out.length} session(s)`);
        break;
      }
      try {
        const summary = await summarize(adapter, file, fingerprint);
        if (summary) {
          out.push(summary);
        }
      } catch (err) {
        logError(`summarize failed for ${file}`, err);
      }
      await yieldToHost();
    }
    out.sort((a, b) => b.percentUsed - a.percentUsed);
    return out;
  }

  /** Resolve a dashboard session back to the open workspace that owns it. */
  async function workspaceRootForSession(
    adapter: BaseAdapter,
    file: string
  ): Promise<string | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const scoped = await adapter.listSessions(folder.uri.fsPath);
        if (scoped.includes(file)) {
          return folder.uri.fsPath;
        }
      } catch (err) {
        logError(`${adapter.name} workspace lookup failed`, err);
      }
    }
    return undefined;
  }

  /** Generate + export a handoff for a specific session file (from the dashboard). */
  async function handoffForFile(file: string, source: Source): Promise<void> {
    try {
      const adapter = adapters.find((a) => a.name === source);
      if (!adapter) {
        void vscode.window.showWarningMessage(
          `Context Control: the ${source} adapter is disabled in settings.`
        );
        return;
      }
      const messages = await adapter.parse(file);
      if (messages.length === 0) {
        void vscode.window.showWarningMessage("Context Control: that session has no messages.");
        return;
      }
      const stats = analyzer.analyze(messages, modelLimitFromMessages(messages));
      const md = generator.generate(messages, stats, source);
      const workspaceRoot = await workspaceRootForSession(adapter, file);
      const saved = await exporter.export(md, workspaceRoot);
      void vscode.window.showInformationMessage(`Context Control: handoff saved to ${saved}`);
    } catch (err) {
      // This runs from a webview message handler, where a rejected promise
      // would surface as an unhandled rejection instead of reaching the user.
      logError(`handoff failed for ${file}`, err);
      void vscode.window.showErrorMessage(
        "Context Control: could not generate that handoff. Run 'Context Control: Show Logs'."
      );
    }
  }

  const dashboard = new Dashboard(
    () =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Context Control: scanning sessions…",
          cancellable: true,
        },
        (_progress, token) => collectSummaries(token)
      ),
    handoffForFile,
    readThresholds
  );

  // 3. init watcher over every enabled adapter's storage path.
  // Deferred to after activation (below) so startup stays fast.
  let watcher = new FileWatcher(
    adapters.map((a) => a.getStoragePath()),
    () => void scan(true)
  );

  /** Rebuild adapters + watcher after a settings change, with no reload. */
  async function rebuild(): Promise<void> {
    log("settings changed, rebuilding adapters and watcher");
    await watcher.dispose();
    adapters = buildAdapters();
    latest = undefined;
    summaryCache.clear();
    watcher = new FileWatcher(
      adapters.map((a) => a.getStoragePath()),
      () => void scan(true)
    );
    watcher.start();
    await scan(true);
  }

  async function openCockpit(): Promise<void> {
    if (!latest) {
      await scan(true);
    }
    await vscode.commands.executeCommand("workbench.view.extension.contextControlCockpit");
    try {
      await vscode.commands.executeCommand(`${Cockpit.viewType}.focus`);
    } catch (err: unknown) {
      logError("cockpit focus failed", err);
    }
  }

  async function showMenu(): Promise<void> {
    const picked = await vscode.window.showQuickPick<ContextControlMenuItem>(
      [
        {
          label: "$(dashboard) Open Cockpit",
          description: "live context and quota gauges",
          command: "cockpit",
        },
        {
          label: "$(table) Open Dashboard",
          description: "scan and compare recent sessions",
          command: "dashboard",
        },
        {
          label: "$(export) Generate Handoff",
          description: "save a portable session summary",
          command: "handoff",
        },
        {
          label: "$(sync) Scan Conversations",
          description: "refresh status bar and panels",
          command: "scan",
        },
        {
          label: "$(info) Show Status",
          description: "show current context summary",
          command: "status",
        },
        {
          label: "$(output) Show Logs",
          description: "diagnostics for bug reports",
          command: "logs",
        },
      ],
      {
        placeHolder: "Context Control",
        matchOnDescription: true,
      }
    );
    if (!picked) {
      return;
    }
    switch (picked.command) {
      case "cockpit":
        await vscode.commands.executeCommand("contextControl.cockpit");
        break;
      case "dashboard":
        await vscode.commands.executeCommand("contextControl.dashboard");
        break;
      case "handoff":
        await vscode.commands.executeCommand("contextControl.handoff");
        break;
      case "scan":
        await vscode.commands.executeCommand("contextControl.scan");
        break;
      case "status":
        await vscode.commands.executeCommand("contextControl.status");
        break;
      case "logs":
        await vscode.commands.executeCommand("contextControl.showLogs");
        break;
    }
  }

  // 4. register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("contextControl.menu", () => showMenu()),

    vscode.commands.registerCommand("contextControl.cockpit", () => openCockpit()),

    vscode.commands.registerCommand("contextControl.scan", () => scan(false)),

    vscode.commands.registerCommand("contextControl.status", async () => {
      if (!latest) {
        await scan(true);
      }
      if (!latest) {
        void vscode.window.showInformationMessage("Context Control: no data yet. Run a scan.");
        return;
      }
      const s = latest.stats;
      const eta = Number.isFinite(s.messagesUntilCritical)
        ? `~${s.messagesUntilCritical} messages until critical`
        : "growth rate unknown";
      void vscode.window.showInformationMessage(
        `Context Control [${latest.source}] — ${s.totalTokens}/${s.modelLimit} tokens (${s.percentUsed}%), ` +
          `${s.messagesCount} messages, level: ${s.level}. ` +
          `~${s.tokensPerMessage} tokens/msg, ${eta}. est. cost $${s.estimatedCostUsd.toFixed(2)}. ` +
          `source: ${s.tokenSource}. ${quotaStatus(s)}`
      );
    }),

    vscode.commands.registerCommand("contextControl.handoff", async () => {
      // Generate from the active editor's workspace, not from the globally
      // freshest session tracked by the status bar. In multi-root workspaces
      // those can be different projects.
      const resolved = await handoffWorkspaceRoot();
      if (resolved.cancelled) {
        return;
      }
      const workspaceRoot = resolved.root;
      const selected = await findBestSession(workspaceRoot ? [workspaceRoot] : [undefined]);
      if (!selected) {
        const scope = workspaceRoot ? ` for ${path.basename(workspaceRoot)}` : "";
        void vscode.window.showWarningMessage(
          `Context Control: no conversation found${scope}; no handoff was generated.`
        );
        return;
      }
      const stats = analyzer.analyze(
        selected.messages,
        modelLimitFromMessages(selected.messages)
      );
      const md = generator.generate(selected.messages, stats, selected.adapter.name);
      const saved = await exporter.export(md, selected.workspaceRoot);
      void vscode.window.showInformationMessage(`Context Control: handoff saved to ${saved}`);
    }),

    vscode.commands.registerCommand("contextControl.export", async () => {
      // Alias of handoff: generate + write to .md.
      await vscode.commands.executeCommand("contextControl.handoff");
    }),

    vscode.commands.registerCommand("contextControl.dashboard", () => dashboard.show()),

    vscode.commands.registerCommand("contextControl.showLogs", () => showLog()),

    vscode.window.registerWebviewViewProvider(Cockpit.viewType, cockpit),

    // Settings used to be read once at activation, so changing the enabled
    // adapters did nothing until the window was reloaded.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (REBUILD_KEYS.some((key) => e.affectsConfiguration(key))) {
        void rebuild();
      } else if (e.affectsConfiguration("contextControl")) {
        // Thresholds only affect how existing numbers are classified.
        summaryCache.clear();
        void scan(true);
      }
    }),

    // A folder added to or removed from a multi-root workspace changes which
    // session we should be tracking.
    vscode.workspace.onDidChangeWorkspaceFolders(() => void scan(true))
  );

  // 5. register disposables, then defer the heavy startup work (file watcher +
  // first scan) off the activation path so activation returns immediately. The
  // initial scan still populates the status bar / cockpit and fires the
  // near-limit alert; the watcher then keeps it live on every file write.
  const startupTimer = setTimeout(() => {
    watcher.start();
    void scan(true);
  }, 0);
  context.subscriptions.push(statusBar, {
    dispose: () => {
      clearTimeout(startupTimer);
      void watcher.dispose();
      disposeLog();
    },
  });
}

export function deactivate(): void {
  // Disposables registered on context.subscriptions are cleaned up automatically.
}
