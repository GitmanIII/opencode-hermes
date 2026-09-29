/**
 * opencode-hermes — external memory provider slot (Hermes MemoryProvider).
 *
 * At most ONE provider is active, selected by config `provider`. It adds
 * automatic, retrieval-based recall over an unbounded store — the built-in
 * MEMORY.md/USER.md stays the small always-on curated set.
 */
import { SqliteMemoryProvider } from "./providers/sqlite-memory.ts";

export type ProviderContext = {
  memoryRoot: string;
  providerPath: string;
  prefetchLimit: number;
};

export type ProviderHit = { id: string; text: string; score: number };

export interface MemoryProvider {
  readonly name: string;
  initialize(ctx: ProviderContext): Promise<void>;
  /** Static text appended to the system prompt (may be empty). */
  systemPromptBlock(): string;
  /** Retrieval for the current user message; returns a context block or "". */
  prefetch(query: string): Promise<{ text: string; hits: number }>;
  add(content: string, tags?: string[]): Promise<{ id: string }>;
  search(query: string, limit?: number): Promise<ProviderHit[]>;
  forget(id: string): Promise<boolean>;
  /** Mirror a built-in memory write into the provider store. */
  onMemoryWrite(action: "add" | "replace" | "remove", content: string): Promise<void>;
  shutdown(): void;
}

export function createProvider(name: string): MemoryProvider | null {
  switch (name) {
    case "sqlite":
      return new SqliteMemoryProvider();
    case "none":
    case "":
      return null;
    default:
      return null;
  }
}
