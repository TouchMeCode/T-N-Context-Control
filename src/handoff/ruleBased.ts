import type { ContextStats, NormalizedMessage } from "../core/types";
import { renderHandoff, type HandoffData } from "./template";

/**
 * Rule-based (no-LLM) handoff generator. Extracts a best-effort summary from
 * the conversation using simple heuristics — everything stays local.
 */
export class HandoffGenerator {
  /** File extensions we treat as "real" references (avoids version numbers etc.). */
  private static readonly FILE_EXTENSIONS = new Set([
    "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "json", "jsonl", "md", "txt", "yml", "yaml", "toml",
    "css", "scss", "html", "py", "rs", "go", "java", "rb",
    "sh", "ps1", "sql", "env", "lock", "vue", "svelte",
  ]);

  /** Decision keyword (English + Thai), kept specific to reduce noise. */
  private static readonly DECISION_RE =
    /(?:\b(?:decided|chose|will use|we'll use|going with)\b|ตัดสินใจ(?:ว่า|ใช้)?|เลือกใช้|ตกลงใช้|สรุปว่าจะ)/i;

  generate(messages: NormalizedMessage[], stats: ContextStats, source: string): string {
    const data: HandoffData = {
      timestamp: new Date().toISOString(),
      source,
      messageCount: stats.messagesCount,
      tokens: stats.totalTokens,
      limit: stats.modelLimit,
      percent: stats.percentUsed,
      goal: this.goal(messages),
      progress: this.progress(stats),
      models: this.models(messages),
      decisions: this.decisions(messages),
      pendingTasks: this.pendingTasks(messages),
      files: this.files(messages),
      conversation: this.conversation(messages),
      nextPrompt: this.nextPrompt(messages),
    };
    return renderHandoff(data);
  }

  /** Preserve both ends of the user's intent instead of trusting one noisy turn. */
  private goal(messages: NormalizedMessage[]): string {
    const requests = this.meaningfulMessages(messages)
      .filter((m) => m.role === "user")
      .map((m) => this.clean(m.content))
      .filter((text) => text.length >= 8);
    if (requests.length === 0) {
      return "(no user request found)";
    }
    const first = this.compact(requests[0], 800);
    const latest = this.compact(requests[requests.length - 1], 1200);
    return requests.length === 1 || first === latest
      ? latest
      : `**Initial request:** ${first}\n\n**Latest request:** ${latest}`;
  }

  private progress(stats: ContextStats): string {
    return `${stats.messagesCount} messages exchanged, ${stats.totalTokens} tokens used (${stats.percentUsed}% of ${stats.modelLimit}). Token source: ${stats.tokenSource}.`;
  }

  /** Ordered model history; the final entry is the model active at handoff time. */
  private models(messages: NormalizedMessage[]): string {
    const ordered: string[] = [];
    for (const message of messages) {
      const model = message.metadata?.model;
      if (model && model !== "<synthetic>" && ordered[ordered.length - 1] !== model) {
        ordered.push(model);
      }
    }
    if (ordered.length === 0) {
      return "- (not reported)";
    }
    return ordered
      .map((model, index) =>
        `- ${model}${index === ordered.length - 1 ? " (active at handoff)" : ""}`
      )
      .join("\n");
  }

  /** Sentences mentioning a decision keyword. Skips tool output and table rows. */
  private decisions(messages: NormalizedMessage[]): string {
    const found = new Set<string>();
    for (const m of this.meaningfulMessages(messages)) {
      const cleaned = this.clean(m.content);
      for (const raw of this.sentences(cleaned)) {
        const sentence = raw.trim().replace(/^[-*|]\s*/, "");
        if (sentence.length < 15 || sentence.length > 200) {
          continue;
        }
        if (sentence.startsWith("|")) {
          continue; // markdown table row
        }
        if (HandoffGenerator.DECISION_RE.test(sentence)) {
          found.add(`- ${sentence}`);
        }
        if (found.size >= 8) {
          break;
        }
      }
      if (found.size >= 8) {
        break;
      }
    }
    return found.size ? [...found].join("\n") : "- (none detected)";
  }

  /** Whole-line TODO / FIXME items, de-duplicated. */
  private pendingTasks(messages: NormalizedMessage[]): string {
    const tasks = new Set<string>();
    for (const m of this.meaningfulMessages(messages)) {
      for (const line of this.clean(m.content, true).split(/\r?\n/)) {
        const todo = line.match(/\b(TODO|FIXME)\b[:\s]+(.*)/i);
        const unchecked = line.match(/^\s*[-*]\s*\[\s\]\s+(.+)/);
        const body = (todo?.[2] ?? unchecked?.[1])?.replace(/[`*]/g, "").trim();
        if (body && body.length >= 4) {
          const prefix = todo ? `${todo[1].toUpperCase()}: ` : "";
          tasks.add(`- ${prefix}${body.slice(0, 240)}`);
        }
      }
    }
    return tasks.size ? [...tasks].slice(0, 20).join("\n") : "- (none detected)";
  }

  /**
   * Files referenced. Prefers the real edited-file list captured from
   * file-history snapshots (metadata.filesReferenced); falls back to scanning
   * message text for path-looking tokens with a known extension.
   */
  private files(messages: NormalizedMessage[]): string {
    const edited = new Set<string>();
    for (const m of messages) {
      for (const f of m.metadata?.filesReferenced ?? []) {
        edited.add(f);
      }
    }
    if (edited.size > 0) {
      return [...edited]
        .slice(0, 60)
        .map((f) => `- ${f}`)
        .join("\n");
    }

    const re = /(?:[A-Za-z]:[\\/])?[\w./\\-]+\.\w+/g;
    const files = new Set<string>();
    for (const m of this.meaningfulMessages(messages)) {
      const matches = this.clean(m.content).match(re);
      if (!matches) {
        continue;
      }
      for (const candidate of matches) {
        const ext = candidate.split(".").pop()?.toLowerCase() ?? "";
        if (
          candidate.length <= 120 &&
          HandoffGenerator.FILE_EXTENSIONS.has(ext) &&
          // reject pure version-like tokens (e.g. 0.1.0 already excluded by ext,
          // but also drop anything whose name part is only digits/dots)
          !/^[\d.]+$/.test(candidate)
        ) {
          files.add(candidate);
        }
      }
    }
    return files.size
      ? [...files].slice(0, 40).map((f) => `- ${f}`).join("\n")
      : "- (none detected)";
  }

  /**
   * A compact extract of every meaningful narrative turn. This is the reliable
   * fallback for a local-only generator: it never pretends a regex produced an
   * LLM-quality summary, but it gives the next assistant the whole discussion.
   */
  private conversation(messages: NormalizedMessage[]): string {
    const turns = this.meaningfulMessages(messages);
    if (turns.length === 0) {
      return "(no narrative conversation found)";
    }
    // Keep the complete handoff practical even for very long sessions. Every
    // turn remains represented; long turns retain both their start and end.
    const perTurn = Math.max(40, Math.min(1200, Math.floor(48_000 / turns.length) - 40));
    return turns
      .map((m, index) => {
        const role = m.role === "user" ? "User" : "Assistant";
        return `### ${index + 1}. ${role}\n${this.compact(this.clean(m.content), perTurn)}`;
      })
      .join("\n\n");
  }

  /** The continuation instruction is based on the user, never an assistant echo. */
  private nextPrompt(messages: NormalizedMessage[]): string {
    const users = this.meaningfulMessages(messages).filter((m) => m.role === "user");
    if (users.length === 0) {
      return "Review the conversation timeline above and continue the unfinished work.";
    }
    const latest = this.compact(this.clean(users[users.length - 1].content), 1600);
    return (
      `Continue this session from the handoff. The user's latest request was:\n\n` +
      `> ${latest.replace(/\n/g, "\n> ")}\n\n` +
      `Use the full timeline above for context, inspect the current workspace state, ` +
      `preserve completed work, finish unresolved items, and verify the result.`
    );
  }

  /**
   * Remove harness noise from message text:
   *  - <ide_opened_file>…</ide_opened_file>, <ide_selection>…, <system-reminder>…
   *  - our own [Tool: …] / [Tool Result: …] markers
   * then collapse whitespace.
   */
  private clean(text: string, preserveNewlines = false): string {
    const cleaned = text
      .replace(
        /<(ide_[a-z_]+|system-reminder|environment_context|skills_instructions|plugins_instructions|collaboration_mode|command-[a-z-]+|external_codex_apps_[a-z_]+|codex_apps_[a-z_]+)>[\s\S]*?<\/\1>/gi,
        " "
      )
      .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, " ")
      .replace(/<\/?(ide_[a-z_]+|system-reminder|environment_context|skills_instructions|plugins_instructions|collaboration_mode|command-[a-z-]+|external_codex_apps_[a-z_]+|codex_apps_[a-z_]+)[^>]*>/gi, " ")
      .replace(/\[Tool(?:\sResult)?:[^\]]*\]/g, " ")
      .trim();
    return preserveNewlines
      ? cleaned.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
      : cleaned.replace(/\s+/g, " ");
  }

  private meaningfulMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
    return messages.filter((m) => {
      if (m.role !== "user" && m.role !== "assistant") {
        return false;
      }
      const text = this.clean(m.content);
      return (
        text.length >= 2 &&
        !/^# Files pasted by the user:[\s\S]*## My request:\s*$/i.test(text) &&
        !/^Base directory for this skill:/i.test(text) &&
        !/^# AGENTS\.md instructions/i.test(text)
      );
    });
  }

  private compact(text: string, max: number): string {
    if (text.length <= max) {
      return text;
    }
    if (max < 40) {
      return `${text.slice(0, Math.max(max - 1, 1))}…`;
    }
    const tail = Math.max(Math.floor(max * 0.3), 16);
    const head = max - tail - 15;
    return `${text.slice(0, head).trimEnd()} …[trimmed]… ${text.slice(-tail).trimStart()}`;
  }

  private sentences(text: string): string[] {
    return text.split(/(?<=[.!?。\n])\s+/).filter((s) => s.trim().length > 0);
  }
}
