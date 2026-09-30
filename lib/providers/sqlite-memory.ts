/**
 * opencode-hermes — reference memory provider: a local SQLite note store.
 *
 * Lightweight (bun:sqlite, no embeddings/external service): keyword-scored
 * retrieval over durable notes. Mirrors built-in memory writes so knowledge
 * that ages out of the capped MEMORY.md/USER.md stays recallable long-term.
 */
import { Database } from "bun:sqlite";
import type { MemoryProvider, MemoryWriteAction, ProviderContext, ProviderHit } from "../memory-provider.ts";

/** Escape SQLite LIKE wildcards so a literal term can't broaden the match. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class SqliteMemoryProvider implements MemoryProvider {
  readonly name = "sqlite";
  private db!: Database;
  private prefetchLimit = 5;

  async initialize(ctx: ProviderContext): Promise<void> {
    this.prefetchLimit = ctx.prefetchLimit;
    this.db = new Database(ctx.providerPath);
    this.db.run(`PRAGMA journal_mode = WAL;`);
    this.db.run(`PRAGMA busy_timeout = 5000;`);
    this.db.run(
      `CREATE TABLE IF NOT EXISTS memo (id TEXT PRIMARY KEY, text TEXT NOT NULL, tags TEXT, created_at INTEGER NOT NULL);`,
    );
  }

  systemPromptBlock(): string {
    return "An external long-term memory store (provider: sqlite) is active. Relevant notes from it are injected automatically before each turn; use the provider_memory tool to search or add notes.";
  }

  async add(content: string, tags?: string[]): Promise<{ id: string }> {
    const text = (content ?? "").trim();
    if (!text) throw new Error("add requires content");
    const id = `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.run(`INSERT INTO memo (id, text, tags, created_at) VALUES (?, ?, ?, ?)`, [id, text, tags?.join(",") ?? null, Date.now()]);
    return { id };
  }

  async search(query: string, limit = 5): Promise<ProviderHit[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    if (!terms.length) return [];
    // Push candidate selection into SQLite (a C-speed scan) so we only score
    // rows that actually contain a term, instead of materializing the whole
    // table into JS. Scoring below still counts exact substring occurrences to
    // preserve ranking.
    const where = terms.map(() => `lower(text) LIKE ? ESCAPE '\\'`).join(" OR ");
    const params = terms.map((t) => `%${escapeLike(t)}%`);
    const rows = this.db.query(`SELECT id, text FROM memo WHERE ${where}`).all(...params) as { id: string; text: string }[];
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
    const hits = await this.search(query, this.prefetchLimit);
    if (!hits.length) return { text: "", hits: 0 };
    const body = hits.map((h) => `• ${h.text.slice(0, 400)}`).join("\n");
    return { text: `<provider-memory source="sqlite">\nRelevant notes from past sessions:\n${body}\n</provider-memory>`, hits: hits.length };
  }

  forget(id: string): boolean {
    this.db.run(`DELETE FROM memo WHERE id = ?`, [id]);
    return true;
  }

  async onMemoryWrite(action: MemoryWriteAction, content: string, oldText?: string): Promise<void> {
    // `demote` is the append-only path: the fact is evicted from the capped
    // file but kept here. `remove`/`replace` propagate the deletion so wrong or
    // superseded facts stop being recalled.
    if (action === "demote") return;
    if (action === "remove") return this.deleteByText(content);
    if (action === "replace") this.deleteByText(oldText ?? "");
    const text = content.trim();
    if (!text) return;
    const dup = this.db.query(`SELECT id FROM memo WHERE text = ? LIMIT 1`).get(text);
    if (!dup) await this.add(text);
  }

  private deleteByText(text: string): void {
    const t = (text ?? "").trim();
    if (!t) return;
    this.db.run(`DELETE FROM memo WHERE text = ?`, [t]);
  }

  shutdown(): void {
    this.db?.close();
  }
}
