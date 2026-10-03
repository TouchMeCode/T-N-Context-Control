// Pure cost estimation — no vscode import so it can be unit-tested in Node.
// Prices are USD per 1M tokens, sourced from the Claude pricing reference
// (cached 2026-05-26). These are estimates: batch/other discounts are ignored.

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

const OPUS: ModelPricing = { inputPerMTok: 5, outputPerMTok: 25 };
const SONNET: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 };
const HAIKU: ModelPricing = { inputPerMTok: 1, outputPerMTok: 5 };

/** Cache cost multipliers, relative to the base input price. */
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

/** Per-message billed token breakdown (from Claude Code `message.usage`). */
export interface UsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
}

/** Infer per-token pricing from a model id (substring match). Defaults to Opus. */
export function inferPricing(model: string | undefined): ModelPricing {
  if (!model) {
    return OPUS;
  }
  const id = model.toLowerCase();
  if (id.includes("haiku")) {
    return HAIKU;
  }
  if (id.includes("sonnet")) {
    return SONNET;
  }
  // opus and unknown models -> Opus pricing
  return OPUS;
}

/** USD cost of one message's usage at the given pricing. */
export function messageCost(usage: UsageBreakdown, pricing: ModelPricing): number {
  const inRate = pricing.inputPerMTok;
  const dollars =
    (usage.input * inRate +
      usage.cacheRead * inRate * CACHE_READ_MULT +
      usage.cacheCreate5m * inRate * CACHE_WRITE_5M_MULT +
      usage.cacheCreate1h * inRate * CACHE_WRITE_1H_MULT +
      usage.output * pricing.outputPerMTok) /
    1_000_000;
  return dollars;
}

/**
 * Total estimated USD cost of a session: the sum of every assistant turn's
 * billed usage (each turn was a separate API call). Messages without a usage
 * breakdown contribute nothing.
 */
export function sessionCostUsd(
  messages: { metadata?: { model?: string; usage?: UsageBreakdown } }[]
): number {
  let total = 0;
  for (const m of messages) {
    const usage = m.metadata?.usage;
    if (usage) {
      total += messageCost(usage, inferPricing(m.metadata?.model));
    }
  }
  return total;
}
