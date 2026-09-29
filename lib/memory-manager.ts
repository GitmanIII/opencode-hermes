/**
 * opencode-hermes — memory manager (built-in + one external provider).
 * Mirrors Hermes' MemoryManager role: the built-in store is always present; an
 * optional provider adds automatic prefetch and an unbounded recall store.
 */
import type { MemoryProvider, MemoryWriteAction, ProviderHit, ReconcileOptions, ReconcileStats } from "./memory-provider.ts";
import type { ResolvedOperation } from "./store.ts";

export class MemoryManager {
  constructor(public readonly provider: MemoryProvider | null) {}

  activeName(): string {
    return this.provider?.name ?? "none";
  }

  systemPromptBlock(): string {
    return this.provider?.systemPromptBlock() ?? "";
  }

  /** Automatic recall for the current user message; "" when nothing/disabled. */
  async prefetch(query: string): Promise<string> {
    if (!this.provider || !query.trim()) return "";
    try {
      return (await this.provider.prefetch(query)).text;
    } catch {
      return "";
    }
  }

  async onMemoryWrite(action: MemoryWriteAction, content: string, oldText?: string): Promise<void> {
    try {
      await this.provider?.onMemoryWrite(action, content, oldText);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Mirror every operation a store batch resolved to (exact entry text). Shared
   * by the `memory` tool and the background/flush review so both paths keep the
   * long-term store consistent with the capped files.
   */
  async mirrorResolved(resolved: ResolvedOperation[] | undefined): Promise<void> {
    if (!resolved?.length) return;
    for (const op of resolved) {
      if (op.action === "add") await this.onMemoryWrite("add", op.content ?? op.matched);
      else if (op.action === "replace") await this.onMemoryWrite("replace", op.content ?? "", op.matched);
      else await this.onMemoryWrite(op.action, op.matched);
    }
  }

  async add(content: string, tags?: string[]): Promise<{ id: string } | undefined> {
    return this.provider ? await this.provider.add(content, tags) : undefined;
  }
  async search(query: string, limit?: number): Promise<ProviderHit[]> {
    return this.provider ? await this.provider.search(query, limit) : [];
  }

  /** Run the provider's optional "dream" reconciliation; undefined if unsupported. */
  async reconcile(canonical: string[], opts?: ReconcileOptions): Promise<ReconcileStats | undefined> {
    if (!this.provider?.reconcile) return undefined;
    try {
      return await this.provider.reconcile(canonical, opts);
    } catch {
      return undefined;
    }
  }
  async forget(id: string): Promise<boolean | undefined> {
    return this.provider ? await this.provider.forget(id) : undefined;
  }

  shutdown(): void {
    this.provider?.shutdown();
  }
}
