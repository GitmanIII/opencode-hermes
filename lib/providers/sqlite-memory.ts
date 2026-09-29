/**
 * opencode-hermes — reference memory provider: a local SQLite note store.
 *
 * Lightweight (bun:sqlite, no embeddings/external service): keyword-scored
 * retrieval over durable notes. Mirrors built-in memory writes so knowledge
 * that ages out of the capped MEMORY.md/USER.md stays recallable long-term.
 */
import { Database } from "bun:sqlite";
import type { MemoryProvider, ProviderContext, ProviderHit } from "../memory-provider.ts";

export class SqliteMemoryProvider implements MemoryProvider {
  readonly name = "sqlite";
  private db!: Database;
  private prefetchLimit = 5;

  async initialize(ctx: ProviderContext): Promise<void> {
    this.prefetchLimit = ctx.prefetchLimit;
    this.db = new Database(ctx.providerPath);
    this.db.run(
      `CREATE TABLE IF NOT EXISTS memo (id TEXT PRIMARY KEY, text TEXT NOT NULL, tags TEXT, created_at INTEGER NOT NULL);`,
    );
  }

  systemPromptBlock(): string {
    return "An external long-term memory store (provider: sqlite) is active. Relevant notes from it are injected automatically before each turn; use the provider_memory tool to search or add notes.";
  }

  add(content: string, tags?: string[]): { id: string } {
    const text = content.trim();
    const id = `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.run(`INSERT INTO memo (id, text, tags, created_at) VALUES (?, ?, ?, ?)`, [id, text, tags?.join(",") ?? null, Date.now()]);
    return { id };
  }

  search(query: string, limit = 5): ProviderHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    if (!terms.length) return [];
    const rows = this.db.query(`SELECT id, text FROM memo`).all() as { id: string; text: string }[];
    const scored: ProviderHit[] = [];
    for (const row of rows) {
      const lower = row.text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let i = lower.indexOf(t);
        while (i !== -1) {
          score++;
          i = lower.indexOf(t, i + t.length);
        }
      }
      if (score > 0) scored.push({ id: row.id, text: row.text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, limit));
  }

  async prefetch(query: string): Promise<{ text: string; hits: number }> {
    const hits = this.search(query, this.prefetchLimit);
    if (!hits.length) return { text: "", hits: 0 };
    const body = hits.map((h) => `• ${h.text.slice(0, 400)}`).join("\n");
    return { text: `<provider-memory source="sqlite">\nRelevant notes from past sessions:\n${body}\n</provider-memory>`, hits: hits.length };
  }

  forget(id: string): boolean {
    this.db.run(`DELETE FROM memo WHERE id = ?`, [id]);
    return true;
  }

  async onMemoryWrite(action: "add" | "replace" | "remove", content: string): Promise<void> {
    // Keep the long-term store append-only: replacement text is the new fact.
    if (action === "remove") return;
    const text = content.trim();
    if (!text) return;
    const dup = this.db.query(`SELECT id FROM memo WHERE text = ? LIMIT 1`).get(text);
    if (!dup) this.add(text);
  }

  shutdown(): void {
    this.db?.close();
  }
}
