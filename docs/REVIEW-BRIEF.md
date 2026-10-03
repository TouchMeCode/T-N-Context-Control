# Code Review Brief — T&N Context Control (for an AI reviewer / Codex)

You are reviewing a **VSCode extension** (TypeScript) that monitors local AI
coding-assistant context usage and generates handoffs. Goal of this review:
**find correctness bugs and edge cases.** Reply with concrete findings
(file:line, why it's wrong, suggested fix). Don't rewrite broadly.

## How to build & verify
```bash
npm install
npm run compile     # tsc type-check -> out/   (no errors expected)
npm test            # node:test unit tests (currently 9 passing)
npm run bundle      # esbuild production bundle -> dist/extension.js
```
- Strict TypeScript, no `any`. Keep it that way.
- No new runtime dependencies without good reason (deps: tiktoken, chokidar).

## Architecture (where things live)
- `src/extension.ts` — activation, command registration, scan loop, dashboard wiring.
- `src/core/types.ts` — `NormalizedMessage`, `ContextStats`, `IAdapter`.
- `src/core/tokenizer.ts` — tiktoken cl100k_base + char/4 fallback.
- `src/core/analyzer.ts` — usage→stats; `levelFor` (vscode config); `sanitizeLimit`.
- `src/core/modelLimits.ts` — context-window inference; prefers `metadata.contextWindow`.
- `src/core/pricing.ts` — Claude-only cost; cache multipliers.
- `src/adapters/claudeCode.ts` — `~/.claude/projects/**/*.jsonl` (VERIFIED).
- `src/adapters/codex.ts` — `~/.codex/sessions/**/rollout-*.jsonl` (VERIFIED).
- `src/adapters/cline.ts` — best-effort from docs (NOT verified — see TODOs).
- `src/handoff/{template,ruleBased}.ts` — rule-based handoff generation.
- `src/ui/{statusBar,notifications,dashboard}.ts`, `src/exporters/markdown.ts`,
  `src/watcher/fileWatcher.ts`.

## Token/limit model (so you can judge correctness)
- "Current context" = max `metadata.contextTokens` across messages.
  - Claude Code: input+cache_read+cache_creation+output of each assistant turn.
  - Codex: last `token_count.info.last_token_usage.input_tokens`.
- `modelLimit`: provider-reported window (Codex) > model-name inference > 200k default.
- `sanitizeLimit`: if usage > limit, escalate limit (never report >100%).

## Suspect areas — please scrutinize these specifically
1. **fileWatcher depth vs Codex nesting.** `FileWatcher` uses `depth: 2`, but Codex
   stores files at `sessions/YYYY/MM/DD/rollout-*.jsonl` (3 dir levels below the
   watched root). Does live-update watching actually fire for Codex? Claude Code
   (`projects/<id>/file.jsonl`) is only 1 level. Verify/flag.
2. **Claude `contextTokens` includes `output_tokens`.** Is adding output to the
   prompt-size proxy correct for "context window occupancy"? Over/under-count?
3. **Dashboard cost for Codex shows $0** (no GPT pricing). Intended, but confirm it
   never mislabels GPT sessions with Claude pricing via `sessionCostUsd` defaults.
4. **Dashboard performance:** `collectSummaries` parses up to 50 sessions, some
   tens of MB, on the extension host. Any way it blocks the UI or double-counts?
5. **cline.ts:** entirely unverified field names (`api_req_started`, `tokensIn`,
   etc.). Treat as guesses; flag anything that would throw on a real file.
6. **Workspace scoping:** `encodeProjectId` (Claude) and `sessionCwd` (Codex) —
   path/case/separator edge cases on Windows vs POSIX.
7. **Handoff `ruleBased.ts`:** regex heuristics (files allowlist, decision/TODO
   extraction) — false positives/negatives, ReDoS risk on huge inputs.
8. **JSONL parsing robustness:** malformed/partial last line, very long lines,
   non-UTF8 — should skip gracefully, never crash a scan.
9. **Notifications latch:** warning-once + critical latch logic in `notifications.ts`
   across repeated scans — can it spam or get stuck?
10. **esbuild externals:** `tiktoken`/`chokidar` are external; confirm they resolve
    at runtime from the packaged `node_modules` (tiktoken ships a WASM file).

## Out of scope
- The Cline adapter being unverified is known — don't "fix" by guessing more.
- Branding, license, publishing are done; ignore.
