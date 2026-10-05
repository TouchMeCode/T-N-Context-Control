# Changelog

All notable changes to **T&N Context Control** are listed here.

## [0.2.5] — 2026-10-06

### Security

- Updated the bundled file watcher from `chokidar` 3.6.0 to 4.0.3 and the
  build tool from `esbuild` 0.20.2 to 0.28.2. `npm audit` now reports zero
  known vulnerabilities.
- Added safeguards against committing environment files, private keys,
  credentials, local conversation research, and generated handoffs.
- Added a security policy with a private vulnerability-reporting path.

### Privacy

- Replaced machine-specific paths, project names, session IDs, and preview
  data in the public repository with clearly synthetic examples.
- Added a privacy warning to the public bug-report form so logs and
  screenshots are sanitized before submission.

### Maintenance

- Added CI coverage for Node.js 18 and 22, including compilation, unit tests,
  production bundling, and dashboard QA.
- Added weekly grouped Dependabot updates for production and development
  dependencies.
- No user-facing workflow or UI behavior changed in this patch release.

## [0.2.4] — 2026-10-04

### Fixed

- **Context and provider quota are now unambiguous.** The status bar labels
  context as `Ctx`; a detected lockout takes priority as `Quota: LIMIT`.
- **Claude Code five-hour and weekly lockouts are detected** from its local
  JSONL rejection records and cleared after reset or a successful response.
- **Handoffs now preserve the actual conversation.** Harness/XML noise is
  removed, every meaningful user/assistant turn appears in a compact timeline,
  and the latest user request—not the last assistant reply—drives continuation.
- **Model switching is preserved per turn.** Handoffs and the dashboard show
  the active model and ordered model history while context follows the latest
  provider-reported state and cost remains calculated per message/model.

### Performance

- **Dashboard summaries are cached by path, mtime, and size.** On the 205MB
  real-session smoke set, an unchanged warm scan now measures **16–28 ms**
  instead of **6.6 s**.

### Changed

- Cline is now opt-in until its documented schema can be verified against a
  real installation.
- Repository and issue links now point to the public GitHub project.
- Removed an unused notification method and a stray 935KB source-tree image.

## [0.2.3] — 2026-09-08

Stability and performance release. Sessions grow to tens of megabytes, and
everything below comes from that: the extension used to redo full-file work on
every write.

### Fixed — performance

- **Session files are now read incrementally.** Each scan reads only the bytes
  appended since the previous one instead of re-reading the whole file. On a
  48MB Claude Code session this took a refresh from **~1,020 ms to ~1.9 ms**
  (measured, ~540× faster); an unchanged file now costs ~0.2 ms. This ran on
  every file write, so it was the main source of editor lag during long
  sessions.
- **Sub-agent transcripts no longer trigger rescans.** The watcher was firing
  on `<session>/subagents/*.jsonl`, which the adapters never list as sessions —
  every sub-agent write forced a full re-parse of the main session for nothing.
- **Scans no longer overlap.** A scan that outlasted its debounce could stack
  another on top of it. One runs at a time now, with at most one queued behind.
- **Watcher debounce raised** from 500 ms to 2 s. Context numbers do not need
  sub-second freshness, and providers write several times per turn.
- **Directory scanning is async and cached.** All adapters moved off
  synchronous `fs` calls, which blocked the extension host. The Codex adapter
  walked its entire date-partitioned session tree on every change event; that
  walk is now cached, as is each session's recorded working directory.
- **The Cline adapter caches by file mtime**, so an unchanged task is not
  re-parsed on every scan.
- **The dashboard yields between sessions and can be cancelled.** Scanning up
  to 50 sessions no longer freezes the UI, and its progress notification's
  Cancel button now actually stops the scan.

### Fixed — reliability

- **Settings apply without reloading the window.** Changing
  `contextControl.adapters` rebuilt nothing until a reload; it now rebuilds the
  adapters and the file watcher in place.
- **Multi-root workspaces are handled.** Only the first workspace folder was
  ever considered, so the wrong session could be tracked. Every folder is now
  checked, and the freshest session among them wins.
- **Watcher errors are caught.** A permission or file-handle failure inside
  chokidar could surface as an unhandled error in the extension host.
- **Handoffs generated from the dashboard report their failures** instead of
  rejecting silently out of the webview message handler.

### Added

- **Diagnostics.** A `Context Control` output channel and a
  **Context Control: Show Logs** command. Failures previously went to the
  extension-host console, where no user could see them.
- **The dashboard is now charted.** Ranked context-usage meters with the
  warning and critical thresholds drawn on the track, provider-quota meters
  with a live reset countdown, and estimated cost by project — plus hover and
  keyboard tooltips. The full sortable table is still there below the charts,
  so every value is readable without hovering. Every status bar carries a text
  label (`OK` / `Warning` / `Critical`), so the reading never depends on
  telling green from yellow.

### Changed

- **`tiktoken` removed.** It accounted for ~11MB of the ~12MB package (a WASM
  binary plus encoder tables for four encodings) while only serving the
  fallback path for sources that do not report real token counts — and for
  Claude models it was an approximation anyway. Token estimation now uses a
  characters-per-token heuristic. Claude Code and Codex are unaffected: both
  report real usage, which the extension already preferred.
- **Icon downscaled** from 1254×1254 to 256×256 (935KB → 45KB).
- Together these take the packaged extension from **11.7MB to under 0.5MB**.
- `qna` set to `marketplace`, so the listing has a working place to report bugs.

## [0.2.2]

- Cockpit side panel with live context and provider-quota gauges.
- Dashboard listing every session across tools.
- Codex adapter with real context window and rate-limit reporting.
- Rule-based handoff generation and markdown export.
