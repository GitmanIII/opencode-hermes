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
 *
 * Two storage layouts are supported: OpenCode 1 (`session`/`message`/`part`) and
 * OpenCode 2 (`session_v2`/`session_message`, where a message's text is inline
 * for user rows and inside `content[]` for assistant rows). The layout is
 * detected per database so the same tool works after a V1→V2 upgrade.
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

type Schema = "v1" | "v2";

export function sessionsDbPath(): string {
  return (
    process.env.HERMES_OPENCODE_SESSIONS_DB ??
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
  );
}

function open(dbPath: string): Database {
  return new Database(dbPath, { readonly: true });
}

function detectSchema(db: Database): Schema {
  const row = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_message'`).get();
  return row ? "v2" : "v1";
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Normalized text/role expressions. V1 kept a message's text in `part` rows;
 * V2 stores user text inline and assistant text inside `content[]`.
 */
const V1_TEXT = `json_extract(p.data,'$.text')`;
const V2_TEXT = `CASE sm.type
        WHEN 'user' THEN json_extract(sm.data,'$.text')
        WHEN 'assistant' THEN (SELECT group_concat(json_extract(c.value,'$.text'), char(10))
                                 FROM json_each(sm.data,'$.content') c
                                WHERE json_extract(c.value,'$.type')='text')
      END`;

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
    const schema = detectSchema(db);
    const { query, session_id, around_message_id } = params;
    const limitRaw = Math.floor(params.limit ?? 3);
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 3, 10));

    if (session_id && around_message_id) return scrollShape(db, schema, session_id, around_message_id);
    if (session_id) return readShape(db, schema, session_id);
    if (query && query.trim()) return discoveryShape(db, schema, query.trim(), limit);
    return browseShape(db, schema, limit);
  } catch (err) {
    return { success: false, error: String(err) };
  } finally {
    db.close();
  }
}

type DiscoveryRow = {
  message_id: string;
  session_id: string;
  time_created: number;
  text: string | null;
  title: string | null;
  directory: string | null;
  time_updated: number | null;
};

function discoverySql(schema: Schema, searchTerms: string[]): { sql: string } {
  const textExpr = schema === "v2" ? "m.text" : V1_TEXT;
  const clauses = searchTerms.map(() => `${textExpr} LIKE ? ESCAPE '\\'`).join(" OR ");
  const scoreCases = searchTerms.map(() => `(CASE WHEN ${textExpr} LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`).join(" + ");
  if (schema === "v2") {
    return {
      sql: `WITH m AS (
              SELECT sm.id AS message_id, sm.session_id AS session_id, sm.time_created AS time_created, ${V2_TEXT} AS text
              FROM session_message sm
            )
            SELECT m.message_id, m.session_id, m.time_created, m.text,
                   s.title AS title, s.directory AS directory, s.time_updated AS time_updated,
                   (${scoreCases}) AS term_hits
            FROM m JOIN session_v2 s ON s.id = m.session_id
            WHERE s.parent_id IS NULL
              AND m.text IS NOT NULL
              AND (${clauses})
            ORDER BY term_hits DESC, m.time_created DESC
            LIMIT ?`,
    };
  }
  return {
    sql: `SELECT p.id AS message_id, p.session_id AS session_id, p.time_created AS time_created, ${V1_TEXT} AS text,
                 s.title AS title, s.directory AS directory, s.time_updated AS time_updated,
                 (${scoreCases}) AS term_hits
          FROM part p
          JOIN session s ON s.id = p.session_id
          WHERE s.parent_id IS NULL
            AND json_extract(p.data, '$.type') = 'text'
            AND (${clauses})
          ORDER BY term_hits DESC, p.time_created DESC
          LIMIT ?`,
  };
}

function discoveryShape(db: Database, schema: Schema, query: string, limit: number): SessionSearchResult {
  // Match ANY term (not the exact phrase) so a natural multi-word query like
  // "pigeon detector tuning" still finds messages that contain those words in
  // a different order. Candidates are ordered by how many distinct terms hit,
  // then recency, so the SCAN_LIMIT cut keeps the most relevant rows.
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2))].slice(0, 8);
  const searchTerms = terms.length ? terms : [query.toLowerCase()];
  const patterns = searchTerms.map((t) => `%${escapeLike(t)}%`);

  // Match the message's TEXT, never the raw JSON: `data LIKE '%text%'` also
  // matches structural tokens like `"type":"text"`, so a query containing such
  // a word filled the SCAN_LIMIT window with every text row.
  const { sql } = discoverySql(schema, searchTerms);
  const rows = db.query(sql).all(...patterns, ...patterns, SCAN_LIMIT) as DiscoveryRow[];

  type Hit = { session: { id: string; title: string; directory: string; time: number }; score: number; matches: { message_id: string; time: number; text: string }[] };
  const bySession = new Map<string, Hit>();

  for (const row of rows) {
    const text = row.text;
    if (!text) continue;
    const lower = text.toLowerCase();
    let score = 0;
    for (const t of searchTerms) {
      let i = lower.indexOf(t);
      while (i !== -1) {
        score++;
        i = lower.indexOf(t, i + t.length);
      }
    }
    if (score === 0) continue;
    const hit = bySession.get(row.session_id) ?? {
      session: {
        id: row.session_id,
        title: row.title ?? "(untitled)",
        directory: row.directory ?? "",
        time: row.time_updated ?? row.time_created,
      },
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
    matches: (i === 0 ? h.matches.slice(0, 5) : h.matches.slice(0, 1)).map((m) => ({ ...m, snippet: snippet(m.text, searchTerms[0]) })),
  }));

  return { success: true, shape: "discovery", count: results.length, results, note: results.length === 0 ? "no matching past sessions" : undefined };
}

type SessionRow = { id: string; title: string | null; directory: string | null; time_updated: number };
type MessageRow = { id: string; time_created: number; role: string; text: string | null };

function sessionOf(db: Database, schema: Schema, sessionID: string): SessionRow | null {
  const table = schema === "v2" ? "session_v2" : "session";
  return db.query(`SELECT id, title, directory, time_updated FROM ${table} WHERE id = ?`).get(sessionID) as SessionRow | null;
}

/** All user/assistant messages of a session, oldest first, text extracted per layout. */
function messagesOf(db: Database, schema: Schema, sessionID: string): MessageRow[] {
  if (schema === "v2") {
    return db
      .query(
        `WITH m AS (
           SELECT sm.id AS id, sm.time_created AS time_created,
                  CASE sm.type WHEN 'assistant' THEN 'assistant' ELSE 'user' END AS role,
                  ${V2_TEXT} AS text
           FROM session_message sm
           WHERE sm.session_id = ? AND sm.type IN ('user','assistant')
         )
         SELECT id, time_created, role, text FROM m ORDER BY time_created ASC, id ASC`,
      )
      .all(sessionID) as MessageRow[];
  }
  return db
    .query(
      `SELECT m.id AS id, m.time_created AS time_created,
              CASE WHEN json_extract(m.data,'$.role') = 'assistant' THEN 'assistant' ELSE 'user' END AS role,
              (SELECT ${V1_TEXT} FROM part p
                WHERE p.message_id = m.id AND json_extract(p.data,'$.type')='text'
                ORDER BY p.time_created LIMIT 1) AS text
       FROM message m WHERE m.session_id = ? ORDER BY m.time_created ASC, m.id ASC`,
    )
    .all(sessionID) as MessageRow[];
}

function readShape(db: Database, schema: Schema, sessionID: string): SessionSearchResult {
  const session = sessionOf(db, schema, sessionID);
  if (!session) return { success: false, error: `session ${sessionID} not found` };

  const texts = messagesOf(db, schema, sessionID)
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

function scrollShape(db: Database, schema: Schema, sessionID: string, aroundMessageID: string): SessionSearchResult {
  const msgs = messagesOf(db, schema, sessionID);
  const anchor = msgs.findIndex((m) => m.id === aroundMessageID);
  if (anchor < 0) return { success: false, error: `message ${aroundMessageID} not found in session ${sessionID}` };
  const from = Math.max(0, anchor - SCROLL_WINDOW);
  const to = Math.min(msgs.length, anchor + SCROLL_WINDOW + 1);
  const window = msgs.slice(from, to).map((m) => ({ message_id: m.id, role: m.role, text: (m.text ?? "").slice(0, READ_MESSAGE_CAP) }));
  return { success: true, shape: "scroll", count: window.length, results: [{ session_id: sessionID, around: aroundMessageID, messages: window }] };
}

function browseShape(db: Database, schema: Schema, limit: number): SessionSearchResult {
  const table = schema === "v2" ? "session_v2" : "session";
  const rows = db
    .query(`SELECT id, title, directory, time_updated FROM ${table} WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?`)
    .all(limit) as { id: string; title: string | null; directory: string | null; time_updated: number }[];
  return {
    success: true,
    shape: "browse",
    count: rows.length,
    results: rows.map((r) => ({ session_id: r.id, title: r.title, directory: r.directory, time: r.time_updated, link: `@session/local/${r.id}` })),
  };
}
