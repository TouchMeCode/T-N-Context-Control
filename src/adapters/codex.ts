import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BaseAdapter } from "./base";
import { JsonlTailReader } from "../core/jsonlTail";
import type { NormalizedMessage, RateLimits, RateLimitWindow, Role, Source } from "../core/types";

/**
 * Codex CLI adapter.
 *
 * Schema verified empirically in Phase A (docs/research/findings.md):
 *   path    : ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 *   format  : JSONL; every line is { timestamp, type, payload }
 *   types   : response_item | event_msg | turn_context | session_meta | compacted
 *   messages: type="response_item", payload.type="message" with payload.role
 *             (user|assistant|developer) and payload.content[].text
 *   tools   : payload.type in function_call | custom_tool_call (+ *_output)
 *   tokens  : type="event_msg", payload.type="token_count" →
 *             payload.info.last_token_usage.input_tokens (current prompt size)
 *             and payload.info.model_context_window (the real window)
 *   model   : turn_context.payload.model ; session_meta.payload.cwd = workspace
 */

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

const KEEP_PAYLOAD = new Set([
  "message",
  "function_call",
  "custom_tool_call",
  "function_call_output",
  "custom_tool_call_output",
]);

/** How many session files keep their parsed message list in memory. */
const PARSE_CACHE_LIMIT = 12;

/** How long a directory walk of the session tree stays valid. */
const WALK_TTL_MS = 30_000;

/** Everything accumulated so far for one rollout file. */
interface ParseState {
  messages: NormalizedMessage[];
  model?: string;
  contextWindow?: number;
  contextTokens?: number;
  rateLimits?: RateLimits;
  attachedTo?: NormalizedMessage;
}

export class CodexAdapter extends BaseAdapter {
  name: Source = "codex";

  private readonly tail = new JsonlTailReader();
  private readonly states = new Map<string, ParseState>();
  /** Session headers never change, so a cwd read once is good forever. */
  private readonly cwdCache = new Map<string, string | undefined>();
  private walkCache: { at: number; files: string[] } | undefined;

  getStoragePath(): string {
    return path.join(os.homedir(), ".codex", "sessions");
  }

  /**
   * List rollout files newest-first. When `workspacePath` is given, keep only
   * sessions whose recorded `cwd` matches (read from the session_meta line 1).
   */
  async listSessions(workspacePath?: string): Promise<string[]> {
    const files = await this.sessionFiles();
    const stats = await Promise.all(
      files.map(async (file) => {
        try {
          return { file, mtime: (await fs.promises.stat(file)).mtimeMs };
        } catch {
          return undefined;
        }
      })
    );
    const sorted = stats
      .filter((s): s is { file: string; mtime: number } => s !== undefined)
      .sort((a, b) => b.mtime - a.mtime)
      .map((s) => s.file);

    if (!workspacePath) {
      return sorted;
    }
    const want = this.normalizePathForCompare(workspacePath);
    const scoped: string[] = [];
    for (const f of sorted) {
      const cwd = await this.sessionCwd(f);
      if (cwd !== undefined && this.normalizePathForCompare(cwd) === want) {
        scoped.push(f);
      }
    }
    return scoped.length > 0 ? scoped : sorted;
  }

  /**
   * Rollout paths under the date-partitioned tree, cached briefly.
   *
   * The tree grows one directory per day and is never pruned, so a heavy user
   * accumulates thousands of files. Walking it on every file-change event was
   * the single most expensive thing this adapter did; a short TTL collapses a
   * burst of scans into one walk.
   */
  private async sessionFiles(): Promise<string[]> {
    const cached = this.walkCache;
    if (cached && Date.now() - cached.at < WALK_TTL_MS) {
      return cached.files;
    }
    const files = await this.walkJsonl(this.getStoragePath());
    this.walkCache = { at: Date.now(), files };
    return files;
  }

  /**
   * Parse a rollout file into normalized messages.
   *
   * Incremental, like the Claude Code adapter: only bytes appended since the
   * previous call are read, and the running model / context-window / quota
   * snapshot carry over in the cached state.
   */
  async parse(filePath: string): Promise<NormalizedMessage[]> {
    const { lines, fromStart } = await this.tail.read(filePath);

    let state = this.states.get(filePath);
    if (!state || fromStart) {
      state = { messages: [] };
      this.states.set(filePath, state);
    }
    if (lines.length === 0) {
      return state.messages;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let rec: CodexLine;
      try {
        rec = JSON.parse(trimmed) as CodexLine;
      } catch {
        continue;
      }
      const payload = rec.payload;
      if (!payload || typeof payload !== "object") {
        continue;
      }
      const ptype = String(payload.type ?? "");
      const ts = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();

      if (rec.type === "turn_context" && typeof payload.model === "string") {
        state.model = payload.model;
        continue;
      }

      if (rec.type === "event_msg" && ptype === "token_count") {
        const info = payload.info as Record<string, unknown> | undefined;
        if (info) {
          const window = num(info.model_context_window);
          if (window) {
            state.contextWindow = window;
          }
          const last = info.last_token_usage as Record<string, unknown> | undefined;
          // input_tokens is the full prompt (already includes cached) -> current context.
          const promptTokens = last ? num(last.input_tokens) : 0;
          if (promptTokens) {
            state.contextTokens = promptTokens;
          }
        }
        const parsed = this.parseRateLimits(payload.rate_limits);
        if (parsed) {
          state.rateLimits = parsed; // keep the latest snapshot
        }
        continue;
      }

      if (rec.type !== "response_item" || !KEEP_PAYLOAD.has(ptype)) {
        continue;
      }

      const content = this.contentFor(ptype, payload);
      if (!content) {
        continue;
      }
      state.messages.push({
        id: filePath + ":" + state.messages.length,
        role: this.roleFor(ptype, payload),
        content,
        timestamp: ts,
        source: this.name,
      });
    }

    this.attachSessionMetadata(state);
    this.prune();
    return state.messages;
  }

  /**
   * Hang the real window + current context size off the newest message so the
   * analyzer can report accurate usage. Codex uses GPT models, for which we
   * have no pricing table, so usage/cost is intentionally left unset. The
   * newest message moves as the file grows, so clear the previous holder.
   */
  private attachSessionMetadata(state: ParseState): void {
    if (state.messages.length === 0) {
      return;
    }
    if (
      state.model === undefined &&
      state.contextWindow === undefined &&
      state.contextTokens === undefined &&
      state.rateLimits === undefined
    ) {
      return;
    }
    const last = state.messages[state.messages.length - 1];
    if (state.attachedTo && state.attachedTo !== last && state.attachedTo.metadata) {
      delete state.attachedTo.metadata.model;
      delete state.attachedTo.metadata.contextWindow;
      delete state.attachedTo.metadata.contextTokens;
      delete state.attachedTo.metadata.rateLimits;
    }
    last.metadata = last.metadata ?? {};
    if (state.model) {
      last.metadata.model = state.model;
    }
    if (state.contextWindow) {
      last.metadata.contextWindow = state.contextWindow;
    }
    if (state.contextTokens !== undefined) {
      last.metadata.contextTokens = state.contextTokens;
    }
    if (state.rateLimits) {
      last.metadata.rateLimits = state.rateLimits;
    }
    state.attachedTo = last;
  }

  /** Bound memory: keep only the most recently parsed session files. */
  private prune(): void {
    while (this.states.size > PARSE_CACHE_LIMIT) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (oldest === undefined) {
        return;
      }
      this.states.delete(oldest);
      this.tail.forget(oldest);
    }
  }

  /** Map Codex `rate_limits` payload into our RateLimits shape. */
  private parseRateLimits(raw: unknown): RateLimits | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const r = raw as Record<string, unknown>;
    const win = (v: unknown): RateLimitWindow | undefined => {
      if (!v || typeof v !== "object") {
        return undefined;
      }
      const w = v as Record<string, unknown>;
      if (typeof w.used_percent !== "number") {
        return undefined;
      }
      return {
        usedPercent: w.used_percent,
        windowMinutes: num(w.window_minutes),
        resetsAt: typeof w.resets_at === "number" ? w.resets_at : undefined,
      };
    };
    const primary = win(r.primary);
    const secondary = win(r.secondary);
    if (!primary && !secondary) {
      return undefined;
    }
    return {
      primary,
      secondary,
      planType: typeof r.plan_type === "string" ? r.plan_type : undefined,
    };
  }

  private roleFor(ptype: string, payload: Record<string, unknown>): Role {
    if (ptype === "message") {
      const role = payload.role;
      if (role === "assistant") {
        return "assistant";
      }
      if (role === "developer") {
        return "system";
      }
      return "user";
    }
    if (ptype.endsWith("_output")) {
      return "tool";
    }
    return "assistant"; // function_call / custom_tool_call are assistant actions
  }

  private contentFor(ptype: string, payload: Record<string, unknown>): string {
    if (ptype === "message") {
      const content = payload.content;
      if (typeof content === "string") {
        return content;
      }
      if (!Array.isArray(content)) {
        return "";
      }
      return content
        .map((b) =>
          b && typeof b === "object" ? String((b as Record<string, unknown>).text ?? "") : ""
        )
        .filter(Boolean)
        .join("\n");
    }
    if (ptype === "function_call" || ptype === "custom_tool_call") {
      return `[Tool: ${String(payload.name ?? "unknown")}]`;
    }
    // *_output
    const out = payload.output ?? payload.content ?? "";
    return `[Tool Result: ${this.preview(out)}]`;
  }

  private preview(value: unknown): string {
    const text = (typeof value === "string" ? value : JSON.stringify(value ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }

  /**
   * Read early session metadata and return its recorded cwd, if any. The header
   * of a rollout file is written once and never changes, so the answer is
   * cached for the lifetime of the adapter.
   */
  private async sessionCwd(file: string): Promise<string | undefined> {
    if (this.cwdCache.has(file)) {
      return this.cwdCache.get(file);
    }
    let result: string | undefined;
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(file, "r");
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const lines = buf.toString("utf-8", 0, bytesRead).split(/\r?\n/).slice(0, 20);
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const rec = JSON.parse(line) as CodexLine;
          const cwd = rec.payload?.cwd;
          if (typeof cwd === "string") {
            result = cwd;
            break;
          }
        } catch {
          // Ignore partial or non-metadata lines while probing the header.
        }
      }
    } catch {
      result = undefined;
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.cwdCache.set(file, result);
    return result;
  }

  private normalizePathForCompare(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  /** Recursively collect rollout-*.jsonl files under the date-partitioned tree. */
  private async walkJsonl(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.walkJsonl(full)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
    return out;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
