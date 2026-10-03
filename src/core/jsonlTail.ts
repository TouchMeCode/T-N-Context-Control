import * as fs from "fs";

/** What one call to `read()` produced. */
export interface TailResult {
  /** Complete lines appended since the previous read (or the whole file). */
  lines: string[];
  /**
   * True when the caller must discard any state it accumulated for this file
   * and rebuild it from `lines` — the file was read from byte 0 because it is
   * new, was truncated, or was rewritten.
   */
  fromStart: boolean;
  /** Total file size in bytes at the moment of the read. */
  size: number;
}

interface Cursor {
  /** Byte offset already consumed. */
  size: number;
  /** Bytes after the last newline — an incomplete line held for the next read. */
  pending: Buffer;
  mtimeMs: number;
}

/**
 * Incremental line reader for append-only JSONL conversation logs.
 *
 * Session files reach tens of megabytes (54MB observed), and the providers
 * append to them on every turn. Re-reading the whole file on each change cost
 * ~1s of blocking JSON.parse on the extension host. This reader remembers how
 * far it got and returns only the newly appended lines, so a steady-state
 * refresh is a few kilobytes instead of the entire file.
 *
 * Buffers, not strings, carry the partial-line remainder so a multi-byte UTF-8
 * character split across a read boundary is never corrupted.
 */
export class JsonlTailReader {
  private readonly cursors = new Map<string, Cursor>();

  /** Read whatever is new in `file` since the last call for that same path. */
  async read(file: string): Promise<TailResult> {
    const stat = await fs.promises.stat(file);
    const prev = this.cursors.get(file);

    // Restart from scratch when the file shrank or was replaced — an append-only
    // log that got smaller was rotated, so our offset is meaningless.
    const canResume =
      prev !== undefined && stat.size >= prev.size && stat.mtimeMs >= prev.mtimeMs;
    const start = canResume ? prev.size : 0;
    const pending = canResume ? prev.pending : Buffer.alloc(0);

    if (canResume && stat.size === prev.size) {
      return { lines: [], fromStart: false, size: stat.size };
    }

    const chunk = await this.readRange(file, start, stat.size);
    const buf = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;

    // Split on the last newline: everything before it is complete lines, the
    // remainder is a half-written line we hold until more bytes arrive.
    const lastNewline = buf.lastIndexOf(0x0a);
    const complete = lastNewline >= 0 ? buf.subarray(0, lastNewline) : Buffer.alloc(0);
    const remainder = lastNewline >= 0 ? buf.subarray(lastNewline + 1) : buf;

    this.cursors.set(file, {
      size: stat.size,
      pending: Buffer.from(remainder),
      mtimeMs: stat.mtimeMs,
    });

    const text = complete.toString("utf-8");
    const lines = text.length > 0 ? text.split("\n") : [];
    return { lines, fromStart: !canResume, size: stat.size };
  }

  /** Read bytes [start, end) without pulling the whole file into memory. */
  private async readRange(file: string, start: number, end: number): Promise<Buffer> {
    if (end <= start) {
      return Buffer.alloc(0);
    }
    const handle = await fs.promises.open(file, "r");
    try {
      const length = end - start;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, start);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** Drop cached state for one file (or all of it). */
  forget(file?: string): void {
    if (file === undefined) {
      this.cursors.clear();
    } else {
      this.cursors.delete(file);
    }
  }

  /** Number of files currently tracked — used to bound cache growth. */
  get size(): number {
    return this.cursors.size;
  }

  /** Forget everything but the `keep` most recently read files. */
  prune(keep: number): void {
    if (this.cursors.size <= keep) {
      return;
    }
    // Map preserves insertion order; re-inserting on each read is not done, so
    // drop from the front, which is the least recently added.
    const excess = this.cursors.size - keep;
    let removed = 0;
    for (const key of this.cursors.keys()) {
      if (removed >= excess) {
        break;
      }
      this.cursors.delete(key);
      removed++;
    }
  }
}
