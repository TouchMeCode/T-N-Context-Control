# Changelog

All notable changes to **T&N Context Control** are listed here.

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
