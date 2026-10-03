import type { RateLimitWindow } from "./types";

export interface QuotaThresholds {
  warning: number;
  critical: number;
}

export interface QuotaAlertState {
  warned: boolean;
  criticalActive: boolean;
  windowKey?: string;
}

export type QuotaAlertAction = "none" | "warning" | "critical";

export interface QuotaAlertDecision {
  action: QuotaAlertAction;
  state: QuotaAlertState;
  percent: number;
}

export function createQuotaAlertState(): QuotaAlertState {
  return {
    warned: false,
    criticalActive: false,
  };
}

export function nextQuotaAlert(
  window: RateLimitWindow,
  state: QuotaAlertState,
  thresholds: QuotaThresholds
): QuotaAlertDecision {
  const percent = Math.round(window.usedPercent);
  const windowKey = quotaWindowKey(window);
  const current =
    state.windowKey !== undefined && state.windowKey !== windowKey
      ? createQuotaAlertState()
      : state;

  if (percent >= thresholds.critical) {
    if (current.criticalActive) {
      return {
        action: "none",
        state: { ...current, windowKey },
        percent,
      };
    }
    return {
      action: "critical",
      state: { warned: true, criticalActive: true, windowKey },
      percent,
    };
  }

  const belowWarning = percent < thresholds.warning;
  if (belowWarning) {
    return {
      action: "none",
      state: { warned: false, criticalActive: false, windowKey },
      percent,
    };
  }

  if (current.warned) {
    return {
      action: "none",
      state: { ...current, criticalActive: false, windowKey },
      percent,
    };
  }

  return {
    action: "warning",
    state: { warned: true, criticalActive: false, windowKey },
    percent,
  };
}

function quotaWindowKey(window: RateLimitWindow): string {
  const reset = window.resetsAt === undefined ? "unknown" : String(window.resetsAt);
  return `${window.windowMinutes}:${reset}`;
}
