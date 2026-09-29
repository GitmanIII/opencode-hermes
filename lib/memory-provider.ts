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
  /** Provider-specific options (config `providerOptions`). */
  options?: Record<string, unknown>;
  /** Current project id, for providers that scope notes. */
  projectId?: string;
};

export type ProviderHit = { id: string; text: string; score: number };

/** Mirror actions for built-in memory writes (see `onMemoryWrite`). */
export type MemoryWriteAction = "add" | "replace" | "remove" | "demote";

export interface MemoryProvider {
  readonly name: string;
  initialize(ctx: ProviderContext): Promise<void>;
  /** Static text appended to the system prompt (may be empty). */
  systemPromptBlock(): string;
  /** Retrieval for the current user message; returns a context block or "". */
  prefetch(query: string): Promise<{ text: string; hits: number }>;
  add(content: string, tags?: string[]): Promise<{ id: string }>;
  search(query: string, limit?: number): Promise<ProviderHit[]>;
  forget(id: string): boolean | Promise<boolean>;
  /**
   * Mirror a built-in memory write into the provider store.
   * - `add`:     `content` is the new entry.
   * - `replace`: `content` is the new entry, `oldText` the entry it supersedes
   *              (providers should delete the old text and add the new).
   * - `remove`:  `content` is the wrong/superseded entry (delete it).
   * - `demote`:  `content` is the evicted entry — keep it (this is the
   *              append-only path: facts that age out stay recallable).
   */
  onMemoryWrite(action: MemoryWriteAction, content: string, oldText?: string): Promise<void>;
  /** Optional: providers that scope notes can track the active project. */
  setProject?(projectId: string | null): void;
  shutdown(): void;
}

/** Built-in providers by name (sync). */
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

/**
 * Load a provider: built-in name ("sqlite"/"none"), or an external module spec
 * (file:// URL, path, or npm package) exporting `createProvider(options)` or a
 * default provider factory/instance. This is how companion packages such as
 * `opencode-hermes-embeddings` plug in.
 */
export async function loadProvider(spec: string, options: Record<string, unknown> = {}): Promise<MemoryProvider | null> {
  const name = (spec ?? "").trim();
  if (!name || name === "none") return null;
  if (name === "sqlite") return new SqliteMemoryProvider();

  let mod: Record<string, unknown>;
  try {
    mod = (await import(name)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`cannot load memory provider '${name}': ${String(err)}`);
  }
  const factory = mod.createProvider ?? mod.default ?? mod.provider;
  if (typeof factory === "function") {
    return (factory as (o: Record<string, unknown>) => MemoryProvider)(options);
  }
  if (factory && typeof (factory as MemoryProvider).initialize === "function") {
    return factory as MemoryProvider;
  }
  throw new Error(`memory provider '${name}' must export createProvider() or a default factory`);
}
