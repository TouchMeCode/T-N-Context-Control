# Handoff — v0.2.3 stability release (in progress)

**For:** the next agent picking this up (Codex).
**From:** Claude, session of 2026-10-01.
**Repo:** `D:\Toolst-n\contextbridge-vscode` — VS Code extension `tn-control.tn-context-control`.

---

## 1. State right now

Version bumped to **0.2.3** in `package.json`.

**There is no version control on this project.** `D:\Toolst-n\.git` exists but is an
empty directory — git does not recognise it as a repository (`fatal: not a git
repository`), and nothing has ever been committed. So there is no diff to review, no
way to revert, and the 0.2.2 baseline exists only inside
`tn-context-control-0.2.2.vsix`. Fixing this should come before any further code
changes — see §4.0.

Everything below is verified green as of this handoff:

```bash
cd D:\Toolst-n\contextbridge-vscode
npx tsc -p ./ --noEmit          # clean
npm test                        # 27/27 pass  (compiles to out/ first)
npm run bundle                  # dist/extension.js, 144 KB
npx @vscode/vsce package --allow-missing-repository --no-dependencies
                                # tn-context-control-0.2.3.vsix, 77 KB
```

`--no-dependencies` is now **correct and required**: chokidar is bundled into
`dist/extension.js` (see §3.6), so no `node_modules` ships. Do not drop that flag
without also un-bundling chokidar, or the VSIX balloons back to ~12 MB.

---

## 2. Why this release exists

The extension re-read the entire session JSONL on every file-change event. Real
sessions on the author's machine are 48–54 MB, so each refresh was a ~1 second
blocking `JSON.parse` loop on the extension host, fired every time the AI wrote a
turn. That is the lag users were reporting. Everything in §3 follows from fixing
that, plus the packaging and diagnostics work that a widely-installed extension
needs.

### Measured, on this machine, against real session files

| | before | after |
|---|---|---|
| Refresh of a 48 MB session | **1,023 ms** | **1.9 ms** (~540×) |
| Refresh when the file did not change | 1,023 ms | **0.24 ms** |
| `activate()` | — | **3 ms** |
| VSIX | **11.7 MB** | **77 KB** |

Reproduce with the harnesses in §6. The 1.9 ms figure is the average of 19
single-turn appends to a 48 MB file; the cold first read of that file is ~615 ms
and is unavoidable (it has to be parsed once).

---

## 3. What changed, file by file

### 3.1 `src/core/jsonlTail.ts` — NEW, the core of the fix

`JsonlTailReader.read(file)` returns only the lines appended since the previous
call for that path, plus a `fromStart` flag telling the caller to discard its
accumulated state.

Design points that must not be broken:

- It keeps the **partial trailing line as a `Buffer`**, not a string. Providers are
  writing while we read, so a read can land mid-line *and* mid-UTF-8-sequence.
  Decoding to a string before the newline split would corrupt multi-byte characters
  (Thai text in a conversation, for one). There is a test for exactly this.
- `canResume` requires `stat.size >= prev.size && stat.mtimeMs >= prev.mtimeMs`. A
  file that shrank was rotated or rewritten, so the cursor is meaningless and we
  re-read from 0 with `fromStart: true`.
- `prune(keep)` exists but is currently unused — adapters call `forget()` from their
  own prune loops instead.

### 3.2 `src/adapters/claudeCode.ts`

- `parse()` is now incremental, backed by `JsonlTailReader` plus a per-file
  `ParseState { messages, editedFiles, attachedTo }` in `this.states`.
- **`attachEditedFiles()` is the subtle part.** `metadata.filesReferenced` hangs off
  the *newest* message, and the newest message moves as the file grows. The method
  clears the previous holder before re-attaching, otherwise a stale copy lingers
  mid-conversation and the handoff generator picks up the wrong list. Tested.
- `listSessions()` / `statSessions()` moved to `fs.promises`, and `statSessions()
  deliberately does **not** descend into sub-directories — `<session>/subagents/*.jsonl`
  are sub-agent transcripts, not sessions.

### 3.3 `src/adapters/codex.ts`

Same incremental treatment. Extra pieces:

- `ParseState` also carries the running `model` / `contextWindow` / `contextTokens` /
  `rateLimits`, because those arrive on their own record types and must survive
  between incremental reads. `attachSessionMetadata()` moves them to the newest
  message and clears the old holder, mirroring §3.2.
- `sessionFiles()` caches the recursive walk of `~/.codex/sessions` for
  `WALK_TTL_MS = 30_000`. That tree grows one directory per day forever and was
  being walked synchronously on every change event — the single most expensive
  thing this adapter did.
- `sessionCwd()` is async and cached permanently per path (a rollout header is
  written once and never changes).

### 3.4 `src/adapters/cline.ts`

Cline stores one whole JSON array per task, so there is nothing to read
incrementally. Instead it caches the parse result keyed on `(mtimeMs, size)` and
moved to `fs.promises`. **The adapter is still unverified against real Cline data**
— all the original `// TODO:` markers are intact. See §5.

### 3.5 `src/watcher/fileWatcher.ts`

- Ignores `subagents/`, `node_modules/`, `.git/` via the `IGNORED` regex, applied
  both as chokidar's `ignored` option and again in `isTracked()`.
- Debounce raised 500 ms → **2000 ms** (constructor arg, so it is tunable).
- `start()` is wrapped in try/catch and subscribes to chokidar's `error` event. A
  permission or handle-limit failure used to be able to take down the extension host.

### 3.6 `src/core/tokenizer.ts` + `esbuild.js` + `package.json`

`tiktoken` is **removed**. It was ~11 MB of the 12 MB package (a WASM binary plus
encoder tables for four encodings) and only served the fallback path for sources
that do not report real token counts — and for Claude models it was an approximation
anyway, since Claude uses a different tokenizer. Estimation is now
`Math.ceil(len / 4)`. Claude Code and Codex are unaffected; they report real usage
and the analyzer already preferred it.

`esbuild.js` now bundles chokidar (`external: ["vscode", "fsevents"]`). `fsevents`
is macOS-only, optional, and already inside a try/catch inside chokidar, so leaving
it external keeps the bundle cross-platform. esbuild preserves the laziness of the
`require("chokidar")` inside `FileWatcher.start()`, so it still is not loaded during
activation.

### 3.7 `src/core/log.ts` — NEW, and `contextControl.showLogs`

An `OutputChannel("Context Control")`. Every `console.warn` in the codebase was
replaced with `logError`/`log`. The extension-host console is invisible to users, so
failures were previously unreportable. New command **Context Control: Show Logs**,
also in the quick-pick menu.

### 3.8 `src/extension.ts`

- **Scan serialization.** `scan()` guards with `scanning` / `rescanQueued`: one runs
  at a time, at most one queued behind it. A scan could previously outlast its
  debounce and stack.
- **Multi-root workspaces.** `workspacePaths()` returns every folder; `runScan()`
  collects the newest candidate per folder, then parses only the freshest of them.
  Previously only `workspaceFolders[0]` was consulted.
- **Live settings.** `onDidChangeConfiguration` calls `rebuild()` when
  `contextControl.adapters` changes (rebuilds adapters + watcher in place, no window
  reload), or a plain rescan for threshold changes. `onDidChangeWorkspaceFolders`
  rescans.
- `handoffForFile()` is fully wrapped in try/catch — it runs from a webview message
  handler where a rejection would become an unhandled rejection instead of reaching
  the user.
- `collectSummaries(token)` takes a `CancellationToken`, yields to the event loop
  between files (`yieldToHost()`), and the dashboard's progress moved to
  `ProgressLocation.Notification` with `cancellable: true`.
- `readThresholds()` is exported into the dashboard so the chart's threshold rules
  match the thresholds that actually fire alerts.

### 3.9 `src/ui/dashboard.ts` — rewritten as charts

Constructor signature changed to
`(collect, onHandoff, thresholds)` — the third argument is new.

Message protocol: extension → webview `{type:"loading"}` then
`{type:"data", sessions, thresholds}`; webview → extension `{command:"refresh"}` /
`{command:"handoff", file, source}`.

Layout: filter row (chips + search, one row scoping everything) → 4 KPI stat tiles →
"Context usage by session" ranked meters → a pair of cards (provider quota meters
with live reset countdown, estimated cost by project) → the full sortable table.

Design decisions worth preserving:

- Context and quota are **ratios against a limit**, so they are meters on a fixed
  0–100 % track with the warning/critical thresholds drawn as rules on the track —
  not free-scaled bars. A reader needs to see distance to the alert, not just bar length.
- **Every status bar carries a text label** (`OK` / `Warning` / `Critical`). This is
  not decoration: VS Code's default chart green and yellow measure ΔE 4.9 under
  protanopia (validated, well under the ≥8 threshold), so colour alone is unreadable
  for red-green colour-blind users. Do not remove the labels.
- Cost is one series, so it uses a single hue and needs no legend.
- The table is the accessible twin and is `open` by default — no value is reachable
  only by hovering.
- All DOM is built with `createElement` / `textContent`. Project names and file paths
  come off disk and must never be interpolated into HTML. The CSP is
  `default-src 'none'` with inline style/script only, so there is no CDN to reach for.
- Colours are VS Code theme tokens (`--vscode-charts-*`), so light and dark follow
  the user's theme. Verified rendered in both.

### 3.10 Assets and metadata

- `icon.png` downscaled 1254×1254 → 256×256 (935 KB → 45 KB). The original is kept
  as `icon-source-1254.png` and excluded from the package via `.vscodeignore`. It was
  downscaled with a pure-Node box filter (§6), because the PNG carries a large C2PA
  metadata block that Chromium's decoder rejected.
- `package.json`: `qna: "marketplace"` added, so the listing has a working place to
  report bugs. **`repository` and `bugs.url` still both point at
  `https://tn-control.vercel.app/`**, which is not a git repo — see §5.
- `CHANGELOG.md` written (new file). `README.md` updated for the charts, the new
  commands, the quota settings, and the tokenizer change.

---

## 4. What is left — do these next

### 4.0 P0 — get this under version control first

`.git` is an empty directory, so nothing here is recoverable and none of the work
below is reviewable as a diff. Before touching code:

1. `git init` in `D:\Toolst-n` (or in `contextbridge-vscode`, if the extension should
   be its own repo — **ask the owner which**).
2. Add a `.gitignore` covering `node_modules/`, `dist/`, `out/`, `*.vsix`,
   `.ai-memory/`, `docs/research/`.
3. Ideally commit the **0.2.2 baseline first** — extract it from
   `tn-context-control-0.2.2.vsix` if no source copy survives — then commit this
   0.2.3 work on top, so the change is reviewable.

### 4.1 P0 — the dashboard scan is still slow

**This is the one real unfinished item.** Measured via the smoke harness:

```
dashboard scan : 9346 ms (cold)
dashboard scan : 6624 ms (warm, cached)
```

Cold is expected — 14 sessions totalling 205 MB have to be parsed once. **Warm at
6.6 s is the bug.** Cause: `PARSE_CACHE_LIMIT = 12` in each adapter, but there are
more sessions than that, so every dashboard pass evicts entries that the same pass
then needs again — the cache thrashes and re-parses from scratch.

Recommended fix, in order of value:

1. **Cache the computed `SessionSummary`, not the messages.** In `collectSummaries`
   / `summarize` (`src/extension.ts`), key a summary cache on
   `(file, mtimeMs, size)`. A summary is a handful of numbers; the message array is
   megabytes. An unchanged session then costs one `stat` instead of a parse, and the
   warm dashboard should land in the tens of milliseconds. This also removes the
   pressure that made the adapter cache thrash.
2. Only then consider raising `PARSE_CACHE_LIMIT`. Raising it alone trades CPU for
   tens of MB of retained message arrays in the extension host — the wrong trade.
3. Re-measure with `scratchpad/smoke.js` and update the numbers in `CHANGELOG.md`
   (the changelog currently claims the dashboard "no longer freezes the UI", which is
   true — it yields and is cancellable — but makes no speed claim; keep it that way
   until this is fixed).

### 4.2 P2 — `repository` / `bugs.url` are not a repo

Both point at the marketing site, so the Marketplace renders a broken "Repository"
link. `qna: "marketplace"` is a stopgap. Needs a real git URL (or the fields removed)
— **ask the owner, do not invent one.**

### 4.3 P3 — leftovers

- `src/adapters/Generated image 2.png` — a stray 935 KB image sitting in the source
  tree. Excluded from the VSIX by `src/**`, but it does not belong there. Delete or move.
- `src/ui/notifications.ts:97` — `private thresholds()` is defined and never called.
  Dead since `quotaThresholds()` took over. Remove it.
- The **Cline adapter is still unverified** and still enabled by default. If its field
  names are wrong it reports plausible-looking wrong numbers silently. Either verify
  against a real Cline install or drop it from the `contextControl.adapters` default.
- (Version control is now §4.0 — it is a P0, not a leftover.)

---

## 5. Things not to break

- **`--no-dependencies` on `vsce package`** — see §1.
- **The `fromStart` contract.** Any adapter using `JsonlTailReader` must reset its
  accumulated state when `fromStart` is true, or a rotated file silently doubles
  every message.
- **`attachEditedFiles` / `attachSessionMetadata` clearing the previous holder.**
  Skipping the clear leaves stale metadata on old messages, which the analyzer reads
  back (it scans backwards for the newest `rateLimits`).
- **Status text labels on the charts** — accessibility, not styling. See §3.9.
- **`textContent`, never `innerHTML`, for anything off disk** in the webviews.

---

## 6. Test harnesses

All in the session scratchpad
`C:\Users\user\AppData\Local\Temp\claude\d--Toolst-n\f60d3c99-3480-46f8-b0da-2987a5a1750d\scratchpad\`.
They are throwaway but re-usable — copy anything worth keeping into `test/`.

| File | What it does |
|---|---|
| `smoke.js` | Loads the **production bundle** with a stub `vscode` module, calls `activate()` against the machine's real session files, and reports activation time, status-bar text, dashboard scan times and the output-channel log. Run: `node <scratchpad>/smoke.js "D:\NBCSERV"`. This is the highest-value check — it catches activation crashes and missing externals. |
| `make_preview.py` | Extracts the dashboard HTML out of `dashboard.ts`, injects sample session data and VS Code theme variables, and writes `preview/dashboard-{dark,light}.html` for rendering in a browser. |
| `qa.mjs` / `qa2.mjs` | Playwright scripts asserting tooltip content, filter scoping across charts + table + KPIs, sorting, and the empty state. |
| `resize_icon.js` | Pure-Node PNG decode → box-filter downscale → re-encode. Used for `icon.png`; keep it if the icon is ever regenerated. |

`test/pure.test.js` gained 12 tests (now 27 total) covering `JsonlTailReader`
(append, no-change, torn write, split multi-byte char, truncation, `forget`) and
`ClaudeCodeAdapter` (incremental parse equals full parse, `filesReferenced` follows
the newest message, sidechain skipping, malformed lines). One pre-existing test was
updated to `await adapter.sessionCwd(...)`, which is now async.

---

## 7. Not started

A Facebook announcement post for the release was drafted in chat but not saved
anywhere in the repo. Ask the owner if you need it.
