# Context Control

> by **T&N Control**

A VSCode / Cursor / Windsurf extension that **monitors AI coding context usage**
of your local AI assistant conversations (Claude Code, Codex, Cline) and warns
you before the context window fills up — then generates a portable **handoff**
markdown you can paste into another AI session.

Everything runs **100% locally**. No conversation ever leaves your machine.

## What it does

- Reads conversation history from local storage (no API keys, no network).
- Tracks token usage against the model's real context window.
- Shows a live status bar item (`$(pulse) CC: 45% 116k/258k`).
- Warns at a configurable threshold, alerts when critical.
- Predicts how many messages remain until critical, and estimates cost.
- A **Cockpit** side panel with live gauges: context usage **and** your provider
  quota (Codex 5-hour & weekly limits, with a live reset countdown) — no login
  or API key, read straight from local files.
- A **Dashboard** charting every session across tools: ranked context meters
  with the warning/critical thresholds drawn on the track, provider-quota
  meters with a live reset countdown, and estimated cost by project — with the
  full sortable table underneath.
- Generates a structured handoff (`.md`) with goal, progress, decisions,
  pending TODOs, referenced files, and a suggested next prompt.

## Token counting

- **Claude Code** exposes real token counts in each message's `usage` field, and
  **Codex** reports its real `model_context_window` — Context Control uses those
  directly (most accurate).
- For sources without usage data, it falls back to a characters-per-token
  estimate. (Up to 0.2.2 this used `tiktoken`, which was itself only an
  approximation for Claude models while accounting for ~11MB of the download.)

Session files are read **incrementally** — each refresh reads only the bytes
appended since the last one, so tracking a 50MB conversation costs about two
milliseconds per turn rather than a full re-parse.

## Install

**VS Code** — open the Extensions panel (`Ctrl+Shift+X`), search **“T&N Context
Control”**, and click **Install**. Or run:

```bash
code --install-extension tn-control.tn-context-control
```

**Windsurf / Cursor** — install the packaged file: Extensions panel → `…` →
**Install from VSIX…** → pick `tn-context-control-<version>.vsix`.
(An Open VSX listing for in-app search is planned.)

## Getting started

1. Install the extension and **reload** the window.
2. Open a folder where you use an AI coding assistant (Claude Code / Codex / Cline).
3. A status bar item appears bottom-right, e.g. `$(pulse) CC: 45% 116k/258k`
   — that's your current context usage. Hover it for tokens/message, an estimate
   of how many messages remain until critical, and cost.
4. It turns **yellow** at the warning threshold and **red** when critical.
5. Run a command (`Ctrl+Shift+P` → type “Context Control”):
   - **Open Dashboard** — every session across tools, sorted by usage.
   - **Generate Handoff** — writes a portable summary `.md` to `.ai-memory/` so
     you can continue the work in a fresh AI session before you run out of context.

### Develop from source

```bash
npm install
npm run bundle   # production bundle (or: npm run compile)
npm test         # run the unit tests
```

Press **F5** to launch an Extension Development Host.

## Commands

| Command | Description |
|---------|-------------|
| `Context Control: Scan Conversations` | Scan local storage and analyze the newest session |
| `Context Control: Show Context Status` | Show current token usage, ETA, and cost |
| `Context Control: Open Dashboard` | List all sessions sorted by usage |
| `Context Control: Generate Handoff` | Build a handoff and write it to `.md` |
| `Context Control: Export Handoff to .md` | Alias of Generate Handoff |
| `Context Control: Open Cockpit` | Reveal the sidebar gauges |
| `Context Control: Show Logs` | Open the diagnostics output channel |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `contextControl.warningThreshold` | `75` | % usage that triggers a warning |
| `contextControl.criticalThreshold` | `90` | % usage that triggers a critical alert |
| `contextControl.quotaWarningThreshold` | `80` | % provider quota that triggers a warning |
| `contextControl.quotaCriticalThreshold` | `95` | % provider quota that triggers a critical alert |
| `contextControl.outputDir` | `.ai-memory` | Where handoff files are written (relative to workspace) |
| `contextControl.adapters` | `["claude-code", "cline", "codex"]` | Which adapters to enable |

## Supported adapters

| Adapter | Status |
|---------|--------|
| **Claude Code** | ✅ Verified against real storage (`~/.claude/projects/*.jsonl`) |
| **Codex CLI** | ✅ Verified against real storage (`~/.codex/sessions/**/rollout-*.jsonl`). Uses the provider-reported `model_context_window`. Cost is not estimated (no GPT pricing table). |
| **Cline** | ⚠️ Implemented from public docs, **not yet verified**. See `// TODO:` markers in `src/adapters/cline.ts`. |

## Known limitations

- Where a provider does not report real usage, token counts are a
  characters-per-token estimate.
- The Cline adapter is unverified — field names/paths may differ per version.
- The handoff generator is rule-based (regex/keyword), not LLM-powered, so its
  summaries are best-effort.
- Context window is inferred per model (Opus/Sonnet 4.5+ → 1M, Haiku/older → 200k)
  unless the provider reports it (Codex). If usage exceeds the inferred window,
  the limit is escalated so usage never reports a nonsensical >100%.
- Cost is estimated from published Claude prices (Opus $5/$25, Sonnet $3/$15,
  Haiku $1/$5 per 1M; cache read ×0.1, write ×1.25–2.0). GPT/other providers are
  not priced.
- **Session quota** (the rolling 5-hour / weekly limit that locks you out) is only
  available for **Codex**, which records it in its local session files. Claude Code
  does not store its quota locally, so Claude sessions show **context usage only**
  (check Claude's own Account & Usage panel for its quota). Context tracking and
  the near-limit handoff work for every adapter.

## Reporting a problem

Run **Context Control: Show Logs** and include the output — it records adapter
failures, scan timings, and watcher errors. Bugs can be filed on the extension's
Marketplace Q&A tab.

## Privacy

Context Control reads local files only and never transmits conversation content.
`docs/research/findings.md` and the `.ai-memory/` output folder are gitignored.

## License

Proprietary — © 2026 T&N Control. All rights reserved. See `LICENSE`.
