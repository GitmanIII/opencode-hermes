/**
 * opencode-hermes — session_search harness (hermetic).
 * Builds temp DBs with OpenCode's V1 (session/message/part) and V2
 * (session_v2/session_message) schemas and exercises discovery / browse / read /
 * scroll on both, including hiding child sessions.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionSearch } from "../session-search.ts";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-sess-"));

let passed = 0;
let failed = 0;
const assert = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    failed++;
    console.log(`❌ ${name} ${detail}`);
  }
};

function buildV1(dbPath: string) {
  const db = new Database(dbPath);
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);`);
  db.run(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);
  db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);

  const sess = db.prepare(`INSERT INTO session (id, project_id, parent_id, title, directory, time_created, time_updated) VALUES (?, 'p', ?, ?, '/home/emil', ?, ?)`);
  sess.run("s1", null, "Pigeon detector tuning", 1000, 2000);
  sess.run("s2", null, "Postgres backup notes", 1100, 1500);
  sess.run("s3", "s1", "child subagent", 1200, 1300); // child -> hidden

  const msg = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`);
  const part = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`);
  const addMsg = (id: string, sessionID: string, role: string, text: string, t: number) => {
    msg.run(id, sessionID, t, t, JSON.stringify({ role }));
    part.run(`p_${id}`, id, sessionID, t, t, JSON.stringify({ type: "text", text }));
  };
  addMsg("m1", "s1", "user", "tell me about the pigeon detector", 1000);
  addMsg("m2", "s1", "assistant", "the pigeon detector uses BirdNET to score audio", 1001);
  addMsg("m3", "s2", "user", "unrelated postgres backup note", 1100);
  addMsg("m4", "s3", "user", "child subagent pigeon mention", 1200); // hidden
  addMsg("m5", "s2", "assistant", "the embeddings text is stored as a blob", 1101);
  db.close();
}

function buildV2(dbPath: string) {
  const db = new Database(dbPath);
  db.run(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);`);
  db.run(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);

  const sess = db.prepare(`INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'p', ?, 'slug', '/home/emil', ?, '2.0.32', ?, ?)`);
  sess.run("s1", null, "Pigeon detector tuning", 1000, 2000);
  sess.run("s2", null, "Postgres backup notes", 1100, 1500);
  sess.run("s3", "s1", "child subagent", 1200, 1300); // child -> hidden

  const msg = db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let seq = 0;
  const addMsg = (id: string, sessionID: string, role: string, text: string, t: number) => {
    const data = role === "assistant"
      ? JSON.stringify({ type: "assistant", content: [{ type: "text", text }], model: { id: "m", providerID: "p" } })
      : JSON.stringify({ type: "user", text });
    msg.run(id, sessionID, role, seq++, t, t, data);
  };
  addMsg("m1", "s1", "user", "tell me about the pigeon detector", 1000);
  addMsg("m2", "s1", "assistant", "the pigeon detector uses BirdNET to score audio", 1001);
  addMsg("m3", "s2", "user", "unrelated postgres backup note", 1100);
  addMsg("m4", "s3", "user", "child subagent pigeon mention", 1200); // hidden
  addMsg("m5", "s2", "assistant", "the embeddings text is stored as a blob", 1101);
  db.close();
}

function checkSchema(label: string, dbPath: string) {
  // discovery
  const disc = sessionSearch(dbPath, { query: "pigeon" });
  assert(`${label}: discovery finds the matching session`, disc.success && disc.shape === "discovery" && (disc.count ?? 0) >= 1, JSON.stringify(disc).slice(0, 200));
  assert(`${label}: discovery returns the right session`, (disc.results as any[])[0]?.session_id === "s1", JSON.stringify(disc.results).slice(0, 160));
  assert(`${label}: discovery hydrates matches`, Array.isArray((disc.results as any[])[0]?.matches) && (disc.results as any[])[0].matches.length >= 1);
  assert(`${label}: discovery hides child sessions`, !JSON.stringify(disc.results).includes("s3"));
  const textQ = sessionSearch(dbPath, { query: "text" });
  assert(`${label}: discovery matches message text, not JSON metadata`, textQ.success && (textQ.results as any[]).length === 1 && (textQ.results as any[])[0]?.session_id === "s2", JSON.stringify(textQ.results));
  const discMulti = sessionSearch(dbPath, { query: "BirdNET audio" });
  assert(`${label}: discovery matches non-contiguous terms`, (discMulti.results as any[])[0]?.session_id === "s1", JSON.stringify(discMulti.results).slice(0, 160));

  // browse
  const browse = sessionSearch(dbPath, {});
  assert(`${label}: browse lists recent interactive sessions`, browse.shape === "browse" && (browse.results as any[]).length === 2, JSON.stringify(browse.results));
  assert(`${label}: browse excludes child session`, !(browse.results as any[]).some((r) => r.session_id === "s3"));

  // read
  const read = sessionSearch(dbPath, { session_id: "s1" });
  assert(`${label}: read returns session messages`, read.shape === "read" && (read.results as any[])[0]?.messages.length === 2, JSON.stringify(read).slice(0, 160));
  assert(`${label}: read reports the assistant role`, (read.results as any[])[0]?.messages[1]?.role === "assistant", JSON.stringify(read).slice(0, 200));

  // scroll
  const scroll = sessionSearch(dbPath, { session_id: "s1", around_message_id: "m1" });
  assert(`${label}: scroll returns a window around the anchor`, scroll.shape === "scroll" && (scroll.results as any[])[0]?.messages.length === 2, JSON.stringify(scroll).slice(0, 160));

  // errors
  assert(`${label}: missing session errors cleanly`, sessionSearch(dbPath, { session_id: "nope" }).success === false);
}

const v1Db = path.join(TMP, "opencode-v1.db");
const v2Db = path.join(TMP, "opencode-v2.db");
buildV1(v1Db);
buildV2(v2Db);
checkSchema("v1", v1Db);
checkSchema("v2", v2Db);
assert("bad DB path errors cleanly", sessionSearch(path.join(TMP, "missing.db"), { query: "x" }).success === false);

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
