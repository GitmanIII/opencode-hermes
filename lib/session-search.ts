/**
 * opencode-hermes — session_search (Hermes-style long-term recall).
 *
 * Reads OpenCode's own session database (read-only) and returns ACTUAL stored
 * messages — no LLM. Four shapes inferred from args, like Hermes:
 *   query                          -> discovery (top-N matching sessions)
 *   session_id + around_message_id -> scroll (±window around an anchor)
 *   session_id                     -> read a session's messages
 *   (no args)                      -> browse recent sessions
 *
 * Child/subagent sessions (parent_id set) are hidden, as Hermes hides
 * subagent/tool/kanban sources from user history.
 */
import { Database } from "bun:sqlite";
import * as os from "node:os";
import * as path from "node:path";

export type SessionSearchParams = {
  query?: string;
  session_id?: string;
  around_message_id?: string;
  limit?: number;
};

export type SessionSearchResult = {
  success: boolean;
  shape?: "discovery" | "scroll" | "read" | "browse";
  count?: number;
  results?: unknown[];
  note?: string;
  error?: string;
};

const SCAN_LIMIT = 300;
const READ_MESSAGE_CAP = 2000;
const READ_HEAD = 20;
const READ_TAIL = 20;
const SCROLL_WINDOW = 5;

export function sessionsDbPath(): string {
  return (
    process.env.HERMES_OPENCODE_SESSIONS_DB ??
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
  );
}

function open(dbPath: string): Database {
  return new Database(dbPath, { readonly: true });
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type Row = { id: string; session_id: string; message_id: string; data: string; time_created: number };

function textOf(data: string): string | null {
  try {
    const parsed = JSON.parse(data);
    if (parsed?.type === "text" && typeof parsed.text === "string") return parsed.text;
  } catch {
    /* ignore */
  }
  return null;
}

function roleOf(data: string): string {
  try {
    const parsed = JSON.parse(data);
    return parsed?.role === "assistant" ? "assistant" : "user";
  } catch {
    return "unknown";
  }
}

function snippet(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  const start = Math.max(0, idx < 0 ? 0 : idx - 80);
  const out = text.slice(start, start + 240).replace(/\s+/g, " ").trim();
  return start > 0 ? `…${out}` : out;
}

export function sessionSearch(dbPath: string, params: SessionSearchParams = {}): SessionSearchResult {
  let db: Database;
  try {
    db = open(dbPath);
  } catch (err) {
    return { success: false, error: `cannot open session DB at ${dbPath}: ${String(err)}` };
  }
  try {
    const { query, session_id, around_message_id } = params;
    const limitRaw = Math.floor(params.limit ?? 3);
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 3, 10));

    if (session_id && around_message_id) return scrollShape(db, session_id, around_message_id);
    if (session_id) return readShape(db, session_id);
    if (query && query.trim()) return discoveryShape(db, query.trim(), limit);
    return browseShape(db, limit);
  } catch (err) {
    return { success: false, error: String(err) };
  } finally {
    db.close();
  }
}

function discoveryShape(db: Database, query: string, limit: number): SessionSearchResult {
  const like = `%${escapeLike(query)}%`;
  const rows = db
    .query(
      `SELECT p.id AS id, p.session_id AS session_id, p.message_id AS message_id, p.data AS data, p.time_created AS time_created
       FROM part p
       JOIN session s ON s.id = p.session_id
       WHERE s.parent_id IS NULL
         AND json_extract(p.data, '$.type') = 'text'
         AND p.data LIKE ? ESCAPE '\\'
       ORDER BY p.time_created DESC
       LIMIT ?`,
    )
    .all(like, SCAN_LIMIT) as Row[];

  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  type Hit = { session: { id: string; title: string; directory: string; time: number }; score: number; matches: { message_id: string; time: number; text: string }[] };
  const bySession = new Map<string, Hit>();

  for (const row of rows) {
    const text = textOf(row.data);
    if (!text) continue;
    const lower = text.toLowerCase();
    let score = 0;
    for (const t of terms.length ? terms : [query.toLowerCase()]) {
      let i = lower.indexOf(t);
      while (i !== -1) {
        score++;
        i = lower.indexOf(t, i + t.length);
      }
    }
    if (score === 0) continue;
    const meta = db.query(`SELECT title, directory, time_updated FROM session WHERE id = ?`).get(row.session_id) as
      | { title: string; directory: string; time_updated: number }
      | null;
    const hit = bySession.get(row.session_id) ?? {
      session: { id: row.session_id, title: meta?.title ?? "(untitled)", directory: meta?.directory ?? "", time: meta?.time_updated ?? row.time_created },
      score: 0,
      matches: [],
    };
    hit.score += score;
    hit.matches.push({ message_id: row.message_id, time: row.time_created, text: text.slice(0, READ_MESSAGE_CAP) });
    bySession.set(row.session_id, hit);
  }

  const ranked = [...bySession.values()].sort((a, b) => b.score - a.score || b.session.time - a.session.time).slice(0, limit);
  const results = ranked.map((h, i) => ({
    session_id: h.session.id,
    title: h.session.title,
    directory: h.session.directory,
    time: h.session.time,
    score: h.score,
    link: `@session/local/${h.session.id}`,
    // hydrate the top result with its matching messages
    matches: (i === 0 ? h.matches.slice(0, 5) : h.matches.slice(0, 1)).map((m) => ({ ...m, snippet: snippet(m.text, terms[0] ?? query) })),
  }));

  return { success: true, shape: "discovery", count: results.length, results, note: results.length === 0 ? "no matching past sessions" : undefined };
}

function readShape(db: Database, sessionID: string): SessionSearchResult {
  const session = db.query(`SELECT id, title, directory, time_updated FROM session WHERE id = ?`).get(sessionID) as
    | { id: string; title: string; directory: string; time_updated: number }
    | null;
  if (!session) return { success: false, error: `session ${sessionID} not found` };

  const msgs = db
    .query(
      `SELECT m.id AS id, m.data AS mdata, m.time_created AS time_created,
              (SELECT p.data FROM part p WHERE p.message_id = m.id AND json_extract(p.data,'$.type')='text' ORDER BY p.time_created LIMIT 1) AS pdata
       FROM message m WHERE m.session_id = ? ORDER BY m.time_created ASC`,
    )
    .all(sessionID) as { id: string; mdata: string; time_created: number; pdata: string | null }[];

  const texts = msgs
    .map((m) => ({ role: roleOf(m.mdata), text: m.pdata ? textOf(m.pdata) : null }))
    .filter((m) => m.text && m.text.trim())
    .map((m) => ({ role: m.role, text: m.text!.slice(0, READ_MESSAGE_CAP) }));

  const total = texts.length;
  const bounded = total > READ_HEAD + READ_TAIL ? [...texts.slice(0, READ_HEAD), { role: "…", text: `… ${total - READ_HEAD - READ_TAIL} messages omitted …` }, ...texts.slice(-READ_TAIL)] : texts;

  return {
    success: true,
    shape: "read",
    count: total,
    results: [{ session_id: session.id, title: session.title, directory: session.directory, time: session.time_updated, link: `@session/local/${session.id}`, messages: bounded }],
  };
}

function scrollShape(db: Database, sessionID: string, aroundMessageID: string): SessionSearchResult {
  const msgs = db
    .query(
      `SELECT m.id AS id, m.data AS mdata, m.time_created AS time_created,
              (SELECT p.data FROM part p WHERE p.message_id = m.id AND json_extract(p.data,'$.type')='text' ORDER BY p.time_created LIMIT 1) AS pdata
       FROM message m WHERE m.session_id = ? ORDER BY m.time_created ASC, m.id ASC`,
    )
    .all(sessionID) as { id: string; mdata: string; time_created: number; pdata: string | null }[];
  const anchor = msgs.findIndex((m) => m.id === aroundMessageID);
  if (anchor < 0) return { success: false, error: `message ${aroundMessageID} not found in session ${sessionID}` };
  const from = Math.max(0, anchor - SCROLL_WINDOW);
  const to = Math.min(msgs.length, anchor + SCROLL_WINDOW + 1);
  const window = msgs.slice(from, to).map((m) => ({ message_id: m.id, role: roleOf(m.mdata), text: (m.pdata ? textOf(m.pdata) : "")?.slice(0, READ_MESSAGE_CAP) ?? "" }));
  return { success: true, shape: "scroll", count: window.length, results: [{ session_id: sessionID, around: aroundMessageID, messages: window }] };
}

function browseShape(db: Database, limit: number): SessionSearchResult {
  const rows = db
    .query(
      `SELECT id, title, directory, time_updated FROM session
       WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?`,
    )
    .all(limit) as { id: string; title: string; directory: string; time_updated: number }[];
  return {
    success: true,
    shape: "browse",
    count: rows.length,
    results: rows.map((r) => ({ session_id: r.id, title: r.title, directory: r.directory, time: r.time_updated, link: `@session/local/${r.id}` })),
  };
}
