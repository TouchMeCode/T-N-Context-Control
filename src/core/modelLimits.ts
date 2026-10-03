// Pure model-context-window inference. Intentionally free of any vscode import
// so it can be unit-tested in plain Node.

/** Default context window for Claude models. */
export const DEFAULT_MODEL_LIMIT = 200_000;

/**
 * Infer a model's context window from its model id. Matching is done on
 * substrings so version suffixes (e.g. "claude-opus-4-...") still resolve.
 * Unknown models fall back to DEFAULT_MODEL_LIMIT.
 */
export function inferModelLimit(model: string | undefined): number {
  if (!model) {
    return DEFAULT_MODEL_LIMIT;
  }
  const id = model.toLowerCase();
  // Explicit 1M-context variants advertise it in the id (e.g. "...[1m]").
  if (id.includes("1m") || id.includes("[1m]")) {
    return 1_000_000;
  }
  // Opus 4.5+ and Sonnet 4.5+ ship a 1M context window; older Claude models,
  // Haiku, and unknown models use 200k. Parse the "<family>-<major>-<minor>".
  const match = id.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (match) {
    const family = match[1];
    const major = Number(match[2]);
    const minor = Number(match[3]);
    if (family === "haiku") {
      return 200_000;
    }
    // opus / sonnet: 1M from 4.5 onward.
    if (major > 4 || (major === 4 && minor >= 5)) {
      return 1_000_000;
    }
    return 200_000;
  }
  return DEFAULT_MODEL_LIMIT;
}

/** Pick a context limit for a session. */
export function modelLimitFromMessages(
  messages: { metadata?: { model?: string; contextWindow?: number } }[]
): number {
  // Prefer an explicit window reported by the provider (e.g. Codex).
  for (let i = messages.length - 1; i >= 0; i--) {
    const w = messages[i].metadata?.contextWindow;
    if (typeof w === "number" && w > 0) {
      return w;
    }
  }
  // Otherwise infer from the newest message that carries a model id.
  for (let i = messages.length - 1; i >= 0; i--) {
    const model = messages[i].metadata?.model;
    if (model) {
      return inferModelLimit(model);
    }
  }
  return DEFAULT_MODEL_LIMIT;
}
