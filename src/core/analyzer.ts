import type { ContextStats, Level, NormalizedMessage } from "./types";
import { countMessages } from "./tokenizer";
import { DEFAULT_MODEL_LIMIT } from "./modelLimits";
import { sessionCostUsd } from "./pricing";
import * as vscode from "vscode";

export { DEFAULT_MODEL_LIMIT, inferModelLimit, modelLimitFromMessages } from "./modelLimits";

export class Analyzer {
  /**
   * Analyze a conversation and return context usage stats.
   *
   * Token strategy (per user decision in Phase A):
   *   1. Prefer the real provider usage carried in metadata.contextTokens.
   *      Each assistant message records the cumulative context size at that
   *      point, so the maximum across messages ~= current context usage.
   *   2. Fall back to a character-based estimate when no message exposes usage.
   */
  analyze(messages: NormalizedMessage[], modelLimit: number = DEFAULT_MODEL_LIMIT): ContextStats {
    const usageValues = messages
      .map((m) => m.metadata?.contextTokens)
      .filter((n): n is number => typeof n === "number" && n > 0);

    let totalTokens: number;
    let tokenSource: "usage" | "estimate";
    if (usageValues.length > 0) {
      // Use the CURRENT context (the most recent turn's size), not the historical
      // peak. After the provider auto-compacts, the latest value drops while the
      // peak would stay high and keep us falsely pinned at ~100%. This matches
      // how the tools themselves report "context remaining".
      totalTokens = usageValues[usageValues.length - 1];
      tokenSource = "usage";
    } else {
      totalTokens = countMessages(messages);
      tokenSource = "estimate";
    }

    // Defense-in-depth: you cannot use more context than the window allows, so
    // if observed usage exceeds the inferred limit, the limit was wrong (too
    // small). Escalate to the next sane tier instead of reporting >100%.
    modelLimit = this.sanitizeLimit(modelLimit, totalTokens);

    const percentUsed = modelLimit > 0 ? (totalTokens / modelLimit) * 100 : 0;
    const estimatedRemaining = Math.max(modelLimit - totalTokens, 0);

    const tokensPerMessage =
      messages.length > 0 ? Math.round(totalTokens / messages.length) : 0;
    const messagesUntilCritical = this.messagesUntilCritical(
      totalTokens,
      modelLimit,
      tokensPerMessage
    );

    // Latest provider quota snapshot, if any message carries one.
    let rateLimits;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].metadata?.rateLimits) {
        rateLimits = messages[i].metadata?.rateLimits;
        break;
      }
    }

    return {
      totalTokens,
      modelLimit,
      percentUsed: Math.round(percentUsed * 10) / 10,
      messagesCount: messages.length,
      estimatedRemaining,
      level: this.levelFor(percentUsed),
      tokenSource,
      estimatedCostUsd: sessionCostUsd(messages),
      tokensPerMessage,
      messagesUntilCritical,
      rateLimits,
    };
  }

  /** Raise an obviously-too-small limit so usage can never exceed 100%. */
  private sanitizeLimit(modelLimit: number, totalTokens: number): number {
    if (totalTokens <= modelLimit) {
      return modelLimit;
    }
    // Usage exceeds the inferred window — bump to 1M, or to the observed usage
    // if it is somehow even larger.
    return totalTokens <= 1_000_000 ? 1_000_000 : totalTokens;
  }

  /** How many more messages until the critical threshold, at the current rate. */
  private messagesUntilCritical(
    totalTokens: number,
    modelLimit: number,
    tokensPerMessage: number
  ): number {
    if (tokensPerMessage <= 0) {
      return Infinity;
    }
    const cfg = vscode.workspace.getConfiguration("contextControl");
    const critical = cfg.get<number>("criticalThreshold", 90);
    const criticalTokens = (critical / 100) * modelLimit;
    const remaining = criticalTokens - totalTokens;
    if (remaining <= 0) {
      return 0;
    }
    return Math.floor(remaining / tokensPerMessage);
  }

  /** Map a percentage to a severity level using user-configured thresholds. */
  levelFor(percentUsed: number): Level {
    const cfg = vscode.workspace.getConfiguration("contextControl");
    const warning = cfg.get<number>("warningThreshold", 75);
    const critical = cfg.get<number>("criticalThreshold", 90);

    if (percentUsed >= critical) {
      return "critical";
    }
    if (percentUsed >= warning) {
      return "warning";
    }
    return "ok";
  }
}
