import type { UsageBreakdown } from "./pricing";

export type Role = "user" | "assistant" | "system" | "tool";
export type Source = "claude-code" | "cline" | "cursor" | "codex";
export type Level = "ok" | "warning" | "critical";

/** One rate-limit / quota window reported by the provider (e.g. Codex). */
export interface RateLimitWindow {
  /** Percentage of the quota used (0–100). */
  usedPercent: number;
  /** Length of the rolling window in minutes (e.g. 300 = 5h, 10080 = 7d). */
  windowMinutes: number;
  /** Unix epoch (seconds) when the window resets, if known. */
  resetsAt?: number;
}

/** Provider quota snapshot (e.g. Codex 5h + weekly limits). */
export interface RateLimits {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  /** Subscription tier, e.g. "plus" / "pro". */
  planType?: string;
}

export interface NormalizedMessage {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  source: Source;
  metadata?: {
    model?: string;
    toolName?: string;
    filesReferenced?: string[];
    /**
     * Real context size (in tokens) reported by the provider for this message,
     * if available. For Claude Code this is derived from `message.usage`
     * (input + cache_read + cache_creation + output). When present this is
     * preferred over estimation. See docs/research/findings.md.
     */
    contextTokens?: number;
    /**
     * Explicit context-window size reported by the provider (e.g. Codex's
     * `model_context_window`). Preferred over model-name inference.
     */
    contextWindow?: number;
    /** Billed token breakdown for this turn, used for cost estimation. */
    usage?: UsageBreakdown;
    /** Provider quota snapshot at this point (e.g. Codex rate_limits). */
    rateLimits?: RateLimits;
  };
}

export interface ContextStats {
  totalTokens: number;
  modelLimit: number;
  percentUsed: number;
  messagesCount: number;
  estimatedRemaining: number;
  level: Level;
  /** How totalTokens was obtained: real provider usage vs estimate. */
  tokenSource: "usage" | "estimate";
  /** Estimated cumulative USD cost of the session so far. */
  estimatedCostUsd: number;
  /** Average tokens of context added per message (growth rate). */
  tokensPerMessage: number;
  /**
   * Estimated number of further messages before the critical threshold is hit,
   * based on the current growth rate. `Infinity` when not yet growing.
   */
  messagesUntilCritical: number;
  /** Provider quota snapshot for this session, if reported (e.g. Codex). */
  rateLimits?: RateLimits;
}

export interface IAdapter {
  name: Source;
  getStoragePath(): string;
  parse(filePath: string): Promise<NormalizedMessage[]>;
  /**
   * List session files newest-first. When `workspacePath` is given, prefer the
   * sessions that belong to that workspace (falling back to all sessions).
   */
  listSessions(workspacePath?: string): Promise<string[]>;
}
