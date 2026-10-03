import * as vscode from "vscode";
import type { ContextStats, RateLimitWindow } from "../core/types";

/** Status bar item showing live context usage. */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "contextControl.menu";
    this.item.text = "$(pulse) CC: --";
    this.item.tooltip = "Context Control — click to open tools";
    this.item.show();
  }

  /** Update the displayed percentage / token counts and background color. */
  update(stats: ContextStats): void {
    const used = this.fmt(stats.totalTokens);
    const limit = this.fmt(stats.modelLimit);
    const quotaPercent = this.maxQuotaPercent(stats);
    const quotaLevel = this.quotaLevel(quotaPercent);
    if (quotaPercent !== undefined) {
      const quotaText = quotaPercent >= 100 ? "LIMIT" : `${Math.round(quotaPercent)}%`;
      const icon = quotaLevel === "critical" ? "$(error)" : "$(pulse)";
      this.item.text = `${icon} CC Quota: ${quotaText} · Ctx: ${stats.percentUsed}%`;
    } else {
      this.item.text = `$(pulse) CC Ctx: ${stats.percentUsed}% ${used}/${limit}`;
    }
    const eta = Number.isFinite(stats.messagesUntilCritical)
      ? `~${stats.messagesUntilCritical} messages until critical`
      : "not growing yet";
    const quota = this.quotaTooltip(stats);
    this.item.tooltip =
      `Context Control\n` +
      `${stats.messagesCount} messages\n` +
      `${stats.totalTokens} / ${stats.modelLimit} tokens (${stats.percentUsed}%)\n` +
      `~${stats.tokensPerMessage} tokens/message · ${eta}\n` +
      `est. cost: $${stats.estimatedCostUsd.toFixed(2)}\n` +
      (quota ? `${quota}\n` : "") +
      `source: ${stats.tokenSource}\n` +
      `click to open Context Control tools`;

    const level = this.maxLevel(stats.level, quotaLevel);
    switch (level) {
      case "critical":
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
      case "warning":
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      default:
        this.item.backgroundColor = undefined;
    }
  }

  private maxQuotaPercent(stats: ContextStats): number | undefined {
    const values = [stats.rateLimits?.primary?.usedPercent, stats.rateLimits?.secondary?.usedPercent]
      .filter((value): value is number => typeof value === "number");
    return values.length > 0 ? Math.max(...values) : undefined;
  }

  private quotaLevel(percent: number | undefined): "ok" | "warning" | "critical" {
    if (percent === undefined) {
      return "ok";
    }
    const cfg = vscode.workspace.getConfiguration("contextControl");
    if (percent >= cfg.get<number>("quotaCriticalThreshold", 95)) {
      return "critical";
    }
    if (percent >= cfg.get<number>("quotaWarningThreshold", 80)) {
      return "warning";
    }
    return "ok";
  }

  private maxLevel(
    context: "ok" | "warning" | "critical",
    quota: "ok" | "warning" | "critical"
  ): "ok" | "warning" | "critical" {
    const rank = { ok: 0, warning: 1, critical: 2 } as const;
    return rank[quota] > rank[context] ? quota : context;
  }

  /** 17234 -> "17.2k". */
  private fmt(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  private quotaTooltip(stats: ContextStats): string {
    const limits = stats.rateLimits;
    if (!limits || (!limits.primary && !limits.secondary)) {
      return "";
    }
    const parts: string[] = [];
    const plan = limits.planType ? `${this.titleCase(limits.planType)} plan` : "quota";
    if (limits.primary) {
      parts.push(`${plan} primary: ${this.formatQuota(limits.primary)}`);
    }
    if (limits.secondary) {
      parts.push(`${plan} secondary: ${this.formatQuota(limits.secondary)}`);
    }
    return parts.join("\n");
  }

  private formatQuota(window: RateLimitWindow): string {
    const reset = this.fmtReset(window.resetsAt);
    return `${Math.round(window.usedPercent)}% / ${this.windowLabel(window.windowMinutes)}${
      reset ? `, ${reset}` : ""
    }`;
  }

  private windowLabel(minutes: number): string {
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

  private titleCase(value: string): string {
    return value.length > 0 ? value[0].toUpperCase() + value.slice(1).toLowerCase() : value;
  }

  dispose(): void {
    this.item.dispose();
  }
}
