/** The filesystem fields used to decide whether a cached value is still valid. */
export interface FileFingerprint {
  mtimeMs: number;
  size: number;
}

export type CacheLookup<T> =
  | { hit: true; value: T }
  | { hit: false };

interface CacheEntry<T> extends FileFingerprint {
  value: T;
}

/**
 * A small cache for values derived from whole files.
 *
 * Both mtime and size are checked: size catches appends on filesystems whose
 * timestamp resolution is too coarse to distinguish rapid consecutive writes.
 */
export class FileStatCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  get(key: string, fingerprint: FileFingerprint): CacheLookup<T> {
    const entry = this.entries.get(key);
    if (
      entry &&
      entry.mtimeMs === fingerprint.mtimeMs &&
      entry.size === fingerprint.size
    ) {
      return { hit: true, value: entry.value };
    }
    return { hit: false };
  }

  set(key: string, fingerprint: FileFingerprint, value: T): void {
    this.entries.set(key, { ...fingerprint, value });
  }

  /** Retain only keys that can be used by the current bounded dashboard scan. */
  prune(keep: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) {
      if (!keep.has(key)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
