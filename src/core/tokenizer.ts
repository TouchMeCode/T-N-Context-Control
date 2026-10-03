import type { NormalizedMessage } from "./types";

/**
 * Token estimation for adapters that do NOT report real usage.
 *
 * Claude Code and Codex both expose real token counts (see analyzer.ts), so
 * this path only runs for a source without usage data. It previously loaded
 * `tiktoken`, whose WASM binary and encoder tables made up ~11MB of the 12MB
 * package and could fail to load in restricted environments — a large,
 * fallible dependency serving a fallback. The ~4-characters-per-token
 * heuristic below is within a few percent for prose and code, and for Claude
 * models tiktoken was itself only an approximation (different tokenizer).
 */

/** Average characters per token across English prose and source code. */
const CHARS_PER_TOKEN = 4;

/** Estimate the tokens in a single string. */
export function countTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Sum the estimated tokens across the normalized content of every message. */
export function countMessages(messages: NormalizedMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += countTokens(m.content);
  }
  return total;
}
