import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BaseAdapter } from "./base";
import { JsonlTailReader } from "../core/jsonlTail";
import type {
  NormalizedMessage,
  RateLimits,
  RateLimitWindow,
  Role,
  Source,
} from "../core/types";
import type { UsageBreakdown } from "../core/pricing";

/**
 * Claude Code adapter.
 *
 * Schema verified empirically in Phase A (docs/research/findings.md):
 *   path    : ~/.claude/projects/<project-id>/<session-uuid>.jsonl
 *   format  : JSONL, one record per line
 *   records : each line has a top-level `type`. We keep user/assistant as
 *             messages and mine `file-history-snapshot` records for the real
 *             list of edited files; queue-operation, ai-title, last-prompt and
 *             attachment records are skipped.
 *   role    : message.role
 *   content : message.content is usually an array of blocks
 *             (text | thinking | tool_use | tool_result | image), but a plain
 *             string was observed once, so we handle both.
 *   tokens  : assistant.message.usage carries the real token counts.
 */

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
}

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: ClaudeUsage;
  };
  snapshot?: {
    trackedFileBackups?: Record<string, unknown>;
  };
  error?: string;
  apiErrorStatus?: number;
  quotaLimits?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
  };
}

const KEEP_TYPES = new Set(["user", "assistant"]);

/** How many session files keep their parsed message list in memory. */
const PARSE_CACHE_LIMIT = 12;

/** Messages accumulated so far for one session file. */
interface ParseState {
  messages: NormalizedMessage[];
  editedFiles: Set<string>;
  rateLimits?: RateLimits;
  quotaObservedAt: { primary?: number; secondary?: number };
  /** Message the edited-file list is currently attached to, so we can move it. */
  attachedTo?: NormalizedMessage;
  /** Message the current provider-quota state is attached to. */
  quotaAttachedTo?: NormalizedMessage;
}

export class ClaudeCodeAdapter extends BaseAdapter {
  name: Source = "claude-code";

  private readonly tail = new JsonlTailReader();
  private readonly states = new Map<string, ParseState>();

  getStoragePath(): string {
    return path.join(os.homedir(), ".claude", "projects");
  }

  /**
   * Encode a filesystem path the way Claude Code names its project folders:
   * every non-alphanumeric char becomes "-" and the drive letter is lowercased.
   *   D:\Projects\sample-app       -> d--Projects-sample-app
   *   C:\Work\demo-api             -> c--Work-demo-api
   */
  encodeProjectId(workspacePath: string): string {
    const encoded = workspacePath.replace(/[^A-Za-z0-9]/g, "-");
    return encoded.charAt(0).toLowerCase() + encoded.slice(1);
  }

  /**
   * Return session .jsonl paths newest-first. When `workspacePath` is given and
   * a matching project folder exists, only that project's sessions are returned
   * (so we track the conversation for the open workspace, not a random newest).
   */
  async listSessions(workspacePath?: string): Promise<string[]> {
    const root = this.getStoragePath();

    if (workspacePath) {
      const projectDir = path.join(root, this.encodeProjectId(workspacePath));
      const scoped = await this.statSessions(projectDir);
      if (scoped.length > 0) {
        return scoped.sort((a, b) => b.mtime - a.mtime).map((s) => s.file);
      }
      // fall through to a global scan if the workspace has no sessions yet
    }

    let projects: fs.Dirent[];
    try {
      projects = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return []; // storage dir absent — this tool is not installed
    }

    const sessions: { file: string; mtime: number }[] = [];
    for (const project of projects) {
      if (!project.isDirectory()) {
        continue;
      }
      sessions.push(...(await this.statSessions(path.join(root, project.name))));
    }
    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions.map((s) => s.file);
  }

  /**
   * Stat the .jsonl files directly inside one project dir. Sub-directories
   * (notably `<session>/subagents/`) are deliberately not descended into: those
   * are sub-agent transcripts, not sessions of their own.
   */
  private async statSessions(projectDir: string): Promise<{ file: string; mtime: number }[]> {
    const out: { file: string; mtime: number }[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      return out;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          return;
        }
        const file = path.join(projectDir, entry.name);
        try {
          const stat = await fs.promises.stat(file);
          out.push({ file, mtime: stat.mtimeMs });
        } catch {
          /* ignore unreadable files */
        }
      })
    );
    return out;
  }

  /**
   * Parse a session file into normalized messages.
   *
   * Incremental: only the bytes appended since the previous call are read and
   * decoded, and the resulting messages are appended to the cached list. A
   * 54MB session that cost ~1s to re-read now costs a few milliseconds per
   * turn, which matters because the file watcher calls this on every write.
   */
  async parse(filePath: string): Promise<NormalizedMessage[]> {
    const { lines, fromStart } = await this.tail.read(filePath);

    let state = this.states.get(filePath);
    if (!state || fromStart) {
      state = {
        messages: [],
        editedFiles: new Set<string>(),
        quotaObservedAt: {},
      };
      this.states.set(filePath, state);
    }
    if (lines.length === 0) {
      this.expireQuota(state);
      this.attachQuota(state);
      return state.messages;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let rec: ClaudeRecord;
      try {
        rec = JSON.parse(trimmed) as ClaudeRecord;
      } catch {
        continue; // skip malformed lines rather than crash the scan
      }

      // Mine real edited-file paths from file-history snapshots (#4).
      if (rec.type === "file-history-snapshot") {
        const backups = rec.snapshot?.trackedFileBackups;
        if (backups) {
          for (const filePathKey of Object.keys(backups)) {
            state.editedFiles.add(filePathKey);
          }
        }
        continue;
      }

      if (!rec.type || !KEEP_TYPES.has(rec.type) || !rec.message) {
        continue;
      }
      // Skip sub-agent (sidechain) turns — they inflate the main context count.
      if (rec.isSidechain === true) {
        continue;
      }

      const role = this.normalizeRole(rec.message.role, rec.type);
      const content = this.flattenContent(rec.message.content);
      const timestamp = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();
      const msg: NormalizedMessage = {
        id: rec.uuid ?? `${filePath}:${state.messages.length}`,
        role,
        content,
        timestamp,
        source: this.name,
      };

      const contextTokens = this.contextTokens(rec.message.usage);
      const usage = this.usageBreakdown(rec.message.usage);
      const model = rec.message.model === "<synthetic>" ? undefined : rec.message.model;
      if (model || contextTokens !== undefined || usage) {
        msg.metadata = {};
        if (model) {
          msg.metadata.model = model;
        }
        if (contextTokens !== undefined) {
          msg.metadata.contextTokens = contextTokens;
        }
        if (usage) {
          msg.metadata.usage = usage;
        }
      }
      state.messages.push(msg);

      const quota = this.quotaFromRecord(rec, content);
      if (quota) {
        state.rateLimits = state.rateLimits ?? {};
        state.rateLimits[quota.slot] = quota.window;
        state.quotaObservedAt[quota.slot] = Math.floor(timestamp / 1000);
      } else if (this.isSuccessfulAssistant(rec)) {
        // A real response after a rejection proves the lockout has ended.
        state.rateLimits = undefined;
        state.quotaObservedAt = {};
      }
    }

    this.expireQuota(state);
    this.attachEditedFiles(state);
    this.attachQuota(state);
    this.prune();
    return state.messages;
  }

  /**
   * Hang the real edited-file list off the newest message so the handoff
   * generator can prefer it over regex-guessed paths. On an incremental parse
   * the newest message moves, so clear the previous holder first — otherwise
   * a stale copy would linger mid-conversation.
   */
  private attachEditedFiles(state: ParseState): void {
    if (state.editedFiles.size === 0 || state.messages.length === 0) {
      return;
    }
    const last = state.messages[state.messages.length - 1];
    if (state.attachedTo === last) {
      state.attachedTo.metadata!.filesReferenced = [...state.editedFiles];
      return;
    }
    if (state.attachedTo?.metadata) {
      delete state.attachedTo.metadata.filesReferenced;
    }
    last.metadata = last.metadata ?? {};
    last.metadata.filesReferenced = [...state.editedFiles];
    state.attachedTo = last;
  }

  /** Move the latest Claude quota state to the newest message, without stale copies. */
  private attachQuota(state: ParseState): void {
    if (state.quotaAttachedTo?.metadata) {
      delete state.quotaAttachedTo.metadata.rateLimits;
    }
    state.quotaAttachedTo = undefined;
    if (!state.rateLimits || (!state.rateLimits.primary && !state.rateLimits.secondary)) {
      return;
    }
    const last = state.messages[state.messages.length - 1];
    if (!last) {
      return;
    }
    last.metadata = last.metadata ?? {};
    last.metadata.rateLimits = state.rateLimits;
    state.quotaAttachedTo = last;
  }

  /** Claude records a rejected limit even though it does not expose live percentages. */
  private quotaFromRecord(
    rec: ClaudeRecord,
    content: string
  ): { slot: "primary" | "secondary"; window: RateLimitWindow } | undefined {
    const rejected = rec.error === "rate_limit" || rec.apiErrorStatus === 429;
    if (!rejected) {
      return undefined;
    }
    const kind = rec.quotaLimits?.rateLimitType?.toLowerCase() ?? "";
    const weekly = /week|seven[_-]?day/.test(kind) || /weekly limit/i.test(content);
    const session = /five[_-]?hour|session/.test(kind) || /session limit/i.test(content);
    if (!weekly && !session) {
      return undefined;
    }
    return {
      slot: weekly ? "secondary" : "primary",
      window: {
        usedPercent: 100,
        windowMinutes: weekly ? 10_080 : 300,
        resetsAt:
          typeof rec.quotaLimits?.resetsAt === "number"
            ? rec.quotaLimits.resetsAt
            : undefined,
      },
    };
  }

  private isSuccessfulAssistant(rec: ClaudeRecord): boolean {
    return (
      rec.type === "assistant" &&
      rec.error !== "rate_limit" &&
      rec.apiErrorStatus !== 429 &&
      Boolean(rec.message?.model && rec.message.model !== "<synthetic>")
    );
  }

  /** Drop a rejected-limit marker after its reset (or one full window as fallback). */
  private expireQuota(state: ParseState): void {
    if (!state.rateLimits) {
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const slot of ["primary", "secondary"] as const) {
      const window = state.rateLimits[slot];
      if (!window) {
        continue;
      }
      const observed = state.quotaObservedAt[slot];
      const expiresAt = window.resetsAt ??
        (observed === undefined ? undefined : observed + window.windowMinutes * 60);
      if (expiresAt !== undefined && expiresAt <= now) {
        delete state.rateLimits[slot];
        delete state.quotaObservedAt[slot];
      }
    }
    if (!state.rateLimits.primary && !state.rateLimits.secondary) {
      state.rateLimits = undefined;
    }
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

  private normalizeRole(role: string | undefined, type: string): Role {
    if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
      return role;
    }
    return type === "assistant" ? "assistant" : "user";
  }

  /** Cumulative context size for an assistant turn from real usage numbers. */
  private contextTokens(usage: ClaudeUsage | undefined): number | undefined {
    if (!usage) {
      return undefined;
    }
    const sum =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
    return sum > 0 ? sum : undefined;
  }

  /** Per-message billed token breakdown for cost estimation (#6). */
  private usageBreakdown(usage: ClaudeUsage | undefined): UsageBreakdown | undefined {
    if (!usage) {
      return undefined;
    }
    const create1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    // Prefer the 1h/5m split; fall back to treating all cache creation as 5m.
    const create5m =
      usage.cache_creation?.ephemeral_5m_input_tokens ??
      Math.max((usage.cache_creation_input_tokens ?? 0) - create1h, 0);
    const breakdown: UsageBreakdown = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreate5m: create5m,
      cacheCreate1h: create1h,
    };
    const any =
      breakdown.input ||
      breakdown.output ||
      breakdown.cacheRead ||
      breakdown.cacheCreate5m ||
      breakdown.cacheCreate1h;
    return any ? breakdown : undefined;
  }

  /** Flatten Claude content (array of blocks, or rarely a plain string). */
  private flattenContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case "text":
          parts.push(String(b.text ?? ""));
          break;
        case "thinking":
          // Reasoning text — keep it; it consumes context too.
          parts.push(String(b.thinking ?? ""));
          break;
        case "tool_use":
          parts.push(`[Tool: ${String(b.name ?? "unknown")}]`);
          break;
        case "tool_result":
          parts.push(`[Tool Result: ${this.preview(b.content)}]`);
          break;
        case "image":
          parts.push("[Image]");
          break;
        default:
          break;
      }
    }
    return parts.join("\n");
  }

  /** Short preview of a tool_result, which may be a string or an array. */
  private preview(content: unknown): string {
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((c) =>
          c && typeof c === "object" ? String((c as Record<string, unknown>).text ?? "") : String(c)
        )
        .join(" ");
    }
    text = text.replace(/\s+/g, " ").trim();
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }
}
