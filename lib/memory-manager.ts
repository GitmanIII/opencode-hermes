/**
 * opencode-hermes — memory manager (built-in + one external provider).
 * Mirrors Hermes' MemoryManager role: the built-in store is always present; an
 * optional provider adds automatic prefetch and an unbounded recall store.
 */
import type { MemoryProvider, ProviderHit } from "./memory-provider.ts";

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

  async onMemoryWrite(action: "add" | "replace" | "remove", content: string): Promise<void> {
    try {
      await this.provider?.onMemoryWrite(action, content);
    } catch {
      /* best-effort */
    }
  }

  add(content: string, tags?: string[]): { id: string } | undefined {
    return this.provider?.add(content, tags);
  }
  search(query: string, limit?: number): ProviderHit[] {
    return this.provider?.search(query, limit) ?? [];
  }
  forget(id: string): boolean | undefined {
    return this.provider?.forget(id);
  }

  shutdown(): void {
    this.provider?.shutdown();
  }
}
