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
    /(decided|chose|will use|we'll use|going with|ตัดสินใจ|เลือกใช้|เลือก)/i;

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
      decisions: this.decisions(messages),
      pendingTasks: this.pendingTasks(messages),
      files: this.files(messages),
      nextPrompt: this.nextPrompt(messages),
    };
    return renderHandoff(data);
  }

  /** First meaningful user message, cleaned and truncated to 200 chars. */
  private goal(messages: NormalizedMessage[]): string {
    for (const m of messages) {
      if (m.role !== "user") {
        continue;
      }
      const text = this.clean(m.content);
      if (text.length >= 3) {
        return text.length > 200 ? `${text.slice(0, 200)}…` : text;
      }
    }
    return "(no user message found)";
  }

  private progress(stats: ContextStats): string {
    return `${stats.messagesCount} messages exchanged, ${stats.totalTokens} tokens used (${stats.percentUsed}% of ${stats.modelLimit}). Token source: ${stats.tokenSource}.`;
  }

  /** Sentences mentioning a decision keyword. Skips tool output and table rows. */
  private decisions(messages: NormalizedMessage[]): string {
    const found = new Set<string>();
    for (const m of this.narrativeMessages(messages)) {
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
    for (const m of this.narrativeMessages(messages)) {
      for (const line of this.clean(m.content).split(/\r?\n/)) {
        const match = line.match(/\b(TODO|FIXME)\b[:\s]+(.*)/i);
        if (!match) {
          continue;
        }
        const body = match[2].replace(/[`*]/g, "").trim();
        if (body.length >= 4) {
          tasks.add(`- ${match[1].toUpperCase()}: ${body.slice(0, 160)}`);
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
    for (const m of this.narrativeMessages(messages)) {
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

  /** Latest assistant message, cleaned and truncated. */
  private nextPrompt(messages: NormalizedMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") {
        continue;
      }
      const text = this.clean(m.content);
      if (text.length > 0) {
        return text.length > 400 ? `${text.slice(0, 400)}…` : text;
      }
    }
    return "(no assistant message found)";
  }

  /**
   * Remove harness noise from message text:
   *  - <ide_opened_file>…</ide_opened_file>, <ide_selection>…, <system-reminder>…
   *  - our own [Tool: …] / [Tool Result: …] markers
   * then collapse whitespace.
   */
  private clean(text: string): string {
    return text
      .replace(
        /<(ide_[a-z_]+|system-reminder|environment_context|skills_instructions|plugins_instructions|collaboration_mode|command-[a-z-]+)>[\s\S]*?<\/\1>/gi,
        " "
      )
      .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, " ")
      .replace(/<\/?(ide_[a-z_]+|system-reminder|environment_context|skills_instructions|plugins_instructions|collaboration_mode|command-[a-z-]+)[^>]*>/gi, " ")
      .replace(/\[Tool(?:\sResult)?:[^\]]*\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private narrativeMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
    return messages.filter((m) => m.role === "user" || m.role === "assistant");
  }

  private sentences(text: string): string[] {
    return text.split(/(?<=[.!?。\n])\s+/).filter((s) => s.trim().length > 0);
  }
}
