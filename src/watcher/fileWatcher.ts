import * as fs from "fs";
import type { FSWatcher } from "chokidar";
import { log, logError } from "../core/log";

/** Sub-agent transcripts live here and are not sessions of their own. */
const IGNORED = /(^|[\\/])(subagents|node_modules|\.git)([\\/]|$)/;

/**
 * Watches one or more storage paths for conversation changes and emits a
 * debounced callback so the analyzer is not re-run on every byte written.
 *
 * Two filters keep the callback rate honest:
 *   - path filter: only `.jsonl` / `.json` files that are not inside a
 *     `subagents/` directory. Sub-agent transcripts are written constantly but
 *     are never listed as sessions, so reacting to them was pure overhead.
 *   - debounce: providers write a session file several times per turn; context
 *     numbers do not need sub-second freshness.
 */
export class FileWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly debounceMs: number;

  constructor(
    private readonly paths: string[],
    private readonly onChange: (changedPath: string) => void,
    debounceMs = 2000
  ) {
    this.debounceMs = debounceMs;
  }

  start(): void {
    const existing = this.paths.filter((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (existing.length === 0) {
      log("watcher: no storage paths present, nothing to watch");
      return;
    }
    try {
      // Lazy-require chokidar so it isn't loaded during extension activation.
      const chokidar = require("chokidar") as typeof import("chokidar");
      this.watcher = chokidar.watch(existing, {
        // We do an explicit initial scan ourselves, so skip the costly crawl that
        // would fire an "add" for every pre-existing file at startup. We still get
        // "change"/"add" for live writes — that's what drives the near-limit alert.
        ignoreInitial: true,
        // Codex stores sessions at sessions/YYYY/MM/DD/rollout-*.jsonl.
        depth: 4,
        ignored: IGNORED,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      });
      const handler = (changedPath: string) => this.debounced(changedPath);
      this.watcher.on("add", handler);
      this.watcher.on("change", handler);
      // Without this, a permission or handle-limit failure inside chokidar
      // surfaces as an unhandled error and can take down the extension host.
      this.watcher.on("error", (err) => logError("watcher error", err));
      log(`watcher: watching ${existing.length} path(s)`);
    } catch (err) {
      logError("watcher failed to start", err);
    }
  }

  private debounced(changedPath: string): void {
    if (!this.isTracked(changedPath)) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.onChange(changedPath), this.debounceMs);
  }

  /** True for files an adapter would actually list as a session. */
  private isTracked(file: string): boolean {
    if (IGNORED.test(file)) {
      return false;
    }
    return file.endsWith(".jsonl") || file.endsWith(".json");
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      await this.watcher?.close();
    } catch (err) {
      logError("watcher failed to close", err);
    }
    this.watcher = undefined;
  }
}
