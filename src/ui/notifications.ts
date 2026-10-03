import * as vscode from "vscode";
import type { ContextStats, Source } from "../core/types";
import {
  createQuotaAlertState,
  nextQuotaAlert,
  type QuotaAlertState,
  type QuotaThresholds,
} from "../core/quotaAlert";

/**
 * Threshold notifications. Two independent concerns, each alerted once per
 * crossing:
 *   1. Context window filling up (percent of the model's window).
 *   2. Provider session quota / rate limit (e.g. Codex 5-hour limit) — the one
 *      that actually cuts you off for hours. THIS is the core "warn before the
 *      limit" feature.
 * Both offer a one-click handoff so you can continue in another session.
 */
export class Notifications {
  private warnedThisSession = false;
  private criticalActive = false;
  private quotaState: QuotaAlertState = createQuotaAlertState();
  private sessionKey: string | undefined;

  async react(stats: ContextStats, sessionKey = "global", source?: Source): Promise<void> {
    if (this.sessionKey !== sessionKey) {
      this.sessionKey = sessionKey;
      this.warnedThisSession = false;
      this.criticalActive = false;
      this.quotaState = createQuotaAlertState();
    }
    // Quota first — it's the more urgent, hours-long lockout.
    const quotaCriticalShown = await this.reactQuota(stats, source);
    if (!quotaCriticalShown) {
      await this.reactContext(stats);
    }
  }

  /** Alert on provider session quota (Codex rate limits). */
  private async reactQuota(stats: ContextStats, source?: Source): Promise<boolean> {
    const windows = [stats.rateLimits?.primary, stats.rateLimits?.secondary].filter(
      (window): window is NonNullable<typeof window> => window !== undefined
    );
    const q = windows.reduce(
      (highest, window) =>
        !highest || window.usedPercent > highest.usedPercent ? window : highest,
      undefined as (typeof windows)[number] | undefined
    );
    if (!q) {
      return false;
    }
    const decision = nextQuotaAlert(q, this.quotaState, this.quotaThresholds());
    this.quotaState = decision.state;
    const pct = decision.percent;
    const label = source ? this.sourceLabel(source) : "AI";
    const reset = this.fmtReset(q.resetsAt);

    if (decision.action === "critical") {
      const choice = await vscode.window.showErrorMessage(
        `${label} session quota at ${pct}%${reset ? ` — ${reset}` : ""}. ` +
          `Generate a handoff before you're cut off?`,
        "Generate Handoff"
      );
      if (choice === "Generate Handoff") {
        await vscode.commands.executeCommand("contextControl.handoff");
      }
      return true;
    }

    if (decision.action === "warning") {
      void vscode.window.showWarningMessage(
        `${label} session quota at ${pct}%${reset ? ` — ${reset}` : ""}.`
      );
    }
    return false;
  }

  /** Alert on context-window usage. */
  private async reactContext(stats: ContextStats): Promise<void> {
    if (stats.level === "critical") {
      if (this.criticalActive) {
        return;
      }
      this.criticalActive = true;
      const choice = await vscode.window.showErrorMessage(
        `Context Control: context is at ${stats.percentUsed}% — almost full.`,
        "Generate Handoff"
      );
      if (choice === "Generate Handoff") {
        await vscode.commands.executeCommand("contextControl.handoff");
      }
      return;
    }

    this.criticalActive = false;
    if (stats.level === "warning" && !this.warnedThisSession) {
      this.warnedThisSession = true;
      void vscode.window.showWarningMessage(
        `Context Control: context usage at ${stats.percentUsed}%.`
      );
    }
  }

  private quotaThresholds(): QuotaThresholds {
    const cfg = vscode.workspace.getConfiguration("contextControl");
    return {
      warning: cfg.get<number>("quotaWarningThreshold", 80),
      critical: cfg.get<number>("quotaCriticalThreshold", 95),
    };
  }

  private sourceLabel(source: Source): string {
    switch (source) {
      case "claude-code":
        return "Claude Code";
      case "codex":
        return "Codex";
      case "cline":
        return "Cline";
      case "cursor":
        return "Cursor";
      default:
        return "AI";
    }
  }

  /** "resets in 18m" / "resets in 2h 5m" from an epoch-seconds reset time. */
  private fmtReset(resetsAt?: number): string {
    if (!resetsAt) {
      return "";
    }
    const sec = resetsAt - Math.floor(Date.now() / 1000);
    if (sec <= 0) {
      return "resetting now";
    }
    const mins = Math.round(sec / 60);
    if (mins < 60) {
      return `resets in ${mins}m`;
    }
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `resets in ${h}h ${m}m`;
  }
}
