import type { IAdapter, NormalizedMessage, Source } from "../core/types";

/**
 * Base class for all conversation adapters. Concrete adapters implement the
 * provider-specific storage path, session discovery, and file parsing.
 */
export abstract class BaseAdapter implements IAdapter {
  abstract name: Source;
  abstract getStoragePath(): string;
  abstract parse(filePath: string): Promise<NormalizedMessage[]>;
  abstract listSessions(workspacePath?: string): Promise<string[]>;
}
