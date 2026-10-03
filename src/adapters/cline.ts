import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BaseAdapter } from "./base";
import type { NormalizedMessage, Source } from "../core/types";
import type { UsageBreakdown } from "../core/pricing";

/**
 * Cline adapter.
 *
 * ⚠️ NOT VERIFIED AGAINST REAL DATA. Cline was not installed on the research
 * machine (Phase A / A.2 skipped — confirmed absent in Code, Cursor, and
 * Windsurf). Everything below follows Cline's *documented* storage layout and
 * is marked with `// TODO:` where it must be confirmed once Cline is available.
 *
 * Documented layout:
 *   <editor>/User/globalStorage/saoudrizwan.claude-dev/tasks/<task-id>/
 *     - api_conversation_history.json : Anthropic-style {role, content}[] sent to the API
 *     - ui_messages.json              : Cline's UI log; `api_req_started` entries carry a
 *                                       JSON string with tokensIn/tokensOut/cacheReads/
 *                                       cacheWrites/cost.
 */
/** How many task files keep their parsed message list in memory. */
const PARSE_CACHE_LIMIT = 12;

/** A parse result kept until the underlying file changes. */
interface CachedParse {
  mtimeMs: number;
  size: number;
  messages: NormalizedMessage[];
}

export class ClineAdapter extends BaseAdapter {
  name: Source = "cline";

  /**
   * Cline stores one whole JSON array per task, so there is nothing to read
   * incrementally the way the JSONL adapters do. Caching on (mtime, size)
   * still removes the repeat cost: the watcher fires for every task in the
   * tree, but only the one that actually changed is re-parsed.
   */
  private readonly cache = new Map<string, CachedParse>();

  /** All plausible `…/saoudrizwan.claude-dev/tasks` dirs across host editors. */
  private candidateTaskDirs(): string[] {
    const home = os.homedir();
    const ext = path.join("globalStorage", "saoudrizwan.claude-dev", "tasks");
    // TODO: confirm the editor in use; we probe the common ones and use the
    // first that exists. The user here runs Windsurf, which Phase A missed.
    const editors = ["Code", "Cursor", "Windsurf", "Windsurf - Next", "Code - Insiders"];

    const roots: string[] = [];
    if (process.platform === "win32") {
      const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
      for (const e of editors) {
        roots.push(path.join(appData, e, "User", ext));
      }
    } else if (process.platform === "darwin") {
      for (const e of editors) {
        roots.push(path.join(home, "Library", "Application Support", e, "User", ext));
      }
    } else {
      for (const e of editors) {
        roots.push(path.join(home, ".config", e, "User", ext));
      }
    }
    return roots;
  }

  getStoragePath(): string {
    const found = this.candidateTaskDirs().find((p) => fs.existsSync(p));
    return found ?? this.candidateTaskDirs()[0];
  }

  // workspacePath accepted for interface parity but unused: Cline keys tasks by
  // an opaque id, not by workspace path. TODO: map task -> workspace.
  async listSessions(_workspacePath?: string): Promise<string[]> {
    const root = this.candidateTaskDirs().find((p) => fs.existsSync(p));
    if (!root) {
      // Cline not installed on this machine — nothing to scan.
      return [];
    }
    let taskIds: string[];
    try {
      taskIds = await fs.promises.readdir(root);
    } catch {
      return [];
    }
    const stats = await Promise.all(
      taskIds.map(async (taskId) => {
        const file = path.join(root, taskId, "api_conversation_history.json");
        try {
          return { file, mtime: (await fs.promises.stat(file)).mtimeMs };
        } catch {
          return undefined; // task dir without a conversation file
        }
      })
    );
    return stats
      .filter((s): s is { file: string; mtime: number } => s !== undefined)
      .sort((a, b) => b.mtime - a.mtime)
      .map((s) => s.file);
  }

  async parse(filePath: string): Promise<NormalizedMessage[]> {
    // TODO: field names below are from public docs, NOT verified against a real
    // Cline file. Re-run Phase A / A.2 once Cline is installed before trusting.
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return [];
    }
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.messages;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) {
      return [];
    }

    const messages: NormalizedMessage[] = [];
    raw.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const e = entry as Record<string, unknown>;
      const role = e.role === "assistant" ? "assistant" : "user";
      const content = this.flattenContent(e.content);
      messages.push({
        id: filePath + ":" + index,
        role,
        content,
        // TODO: Cline api_conversation_history has no per-message timestamp;
        // using file order. ui_messages.json carries `ts` if we need real times.
        timestamp: Date.now() + index,
        source: this.name,
      });
    });

    // Attach token usage + cost from the sibling ui_messages.json (#6 parity).
    await this.attachUsage(filePath, messages);

    this.cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
    while (this.cache.size > PARSE_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
    return messages;
  }

  /**
   * Read `ui_messages.json` next to the conversation file and pull token/cost
   * out of `api_req_started` entries. Aggregates onto the last assistant
   * message so the analyzer and cost estimator have data to work with.
   */
  private async attachUsage(
    conversationFile: string,
    messages: NormalizedMessage[]
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const uiFile = path.join(path.dirname(conversationFile), "ui_messages.json");
    let ui: unknown;
    try {
      ui = JSON.parse(await fs.promises.readFile(uiFile, "utf-8"));
    } catch {
      return; // absent or unreadable — usage stays unset
    }
    if (!Array.isArray(ui)) {
      return;
    }

    const total: UsageBreakdown = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
    };
    let lastPromptTokens = 0;
    let sawAny = false;

    for (const item of ui) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const m = item as Record<string, unknown>;
      // TODO: verify the discriminator — docs say type:"say", say:"api_req_started".
      if (m.say !== "api_req_started" || typeof m.text !== "string") {
        continue;
      }
      let info: Record<string, unknown>;
      try {
        info = JSON.parse(m.text) as Record<string, unknown>;
      } catch {
        continue;
      }
      const tokensIn = num(info.tokensIn);
      const tokensOut = num(info.tokensOut);
      const cacheReads = num(info.cacheReads);
      const cacheWrites = num(info.cacheWrites);
      total.input += tokensIn;
      total.output += tokensOut;
      total.cacheRead += cacheReads;
      total.cacheCreate5m += cacheWrites; // TODO: Cline doesn't split 5m/1h cache
      lastPromptTokens = tokensIn + cacheReads + cacheWrites;
      sawAny = true;
    }

    if (!sawAny) {
      return;
    }
    const last = messages[messages.length - 1];
    last.metadata = last.metadata ?? {};
    last.metadata.usage = total;
    if (lastPromptTokens > 0) {
      last.metadata.contextTokens = lastPromptTokens;
    }
  }

  private flattenContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((block) => {
        if (!block || typeof block !== "object") {
          return "";
        }
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          return String(b.text ?? "");
        }
        if (b.type === "tool_use") {
          return `[Tool: ${String(b.name ?? "unknown")}]`;
        }
        if (b.type === "tool_result") {
          return "[Tool Result: …]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
}

/** Coerce an unknown JSON value to a non-negative number. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
