/**
 * opencode-hermes — Hermes-core store regression (hermetic).
 * MEMORY.md + USER.md, §-delimited, add/replace/remove + atomic batch,
 * hard char caps with consolidation-failure feedback and a per-turn cap.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractOperations } from "../learn.ts";
import { setMemoryRoot } from "../paths.ts";
import { MemoryStore, splitEntries } from "../store.ts";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-reg-"));
setMemoryRoot(TMP);

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

const store = new MemoryStore({ memoryCharLimit: 2200, userCharLimit: 1375 });
await store.loadFromDisk();
assert("empty store loads", store.entryCount("memory") === 0 && store.entryCount("user") === 0, store.usage("memory"));

// add / idempotent duplicate
let r = await store.add("memory", "durable fact A");
assert("add succeeds", r.success && store.entryCount("memory") === 1);
r = await store.add("memory", "durable fact A");
assert("duplicate add is idempotent", r.success && (r.message ?? "").includes("already exists") && store.entryCount("memory") === 1, r.message);
r = await store.add("memory", "   ");
assert("empty add rejected", !r.success);

// replace / remove
await store.add("memory", "durable fact B");
r = await store.replace("memory", "durable fact B", "durable fact B2");
assert("replace succeeds", r.success);
assert("replace persisted", (await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8")).includes("durable fact B2"));
r = await store.replace("memory", "no such entry", "x");
assert("replace no-match errors with inventory", !r.success && Array.isArray(r.current_entries));
r = await store.remove("memory", "durable fact B2");
assert("remove succeeds", r.success && !store.getEntries("memory").some((e) => e.includes("B2")));

// user target is separate
await store.add("user", "prefers concise answers");
assert("user target isolated", store.entryCount("user") === 1 && store.entryCount("memory") === 1);

// atomic batch: duplicate skipped, replace applied
r = await store.applyBatch("memory", [
  { action: "add", content: "batch X" },
  { action: "add", content: "batch Y" },
  { action: "add", content: "batch X" },
  { action: "replace", old_text: "batch X", content: "batch X2" },
]);
assert("batch applies atomically", r.success && store.getEntries("memory").includes("batch Y") && store.getEntries("memory").includes("batch X2"));
assert("batch dedupes duplicate adds", store.getEntries("memory").filter((e) => e === "batch X").length === 0);

// atomic batch failure leaves store unchanged
const before = [...store.getEntries("memory")];
r = await store.applyBatch("memory", [{ action: "add", content: "temp" }, { action: "remove", old_text: "missing entry" }]);
assert("failed batch is all-or-nothing", !r.success && JSON.stringify(store.getEntries("memory")) === JSON.stringify(before));

// hard cap + consolidation failure + per-turn cap (dedicated root)
const SMALLTMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-reg-small-"));
setMemoryRoot(SMALLTMP);
const small = new MemoryStore({ memoryCharLimit: 100 });
await small.loadFromDisk();
const first = await small.add("memory", "x".repeat(200));
assert("overflow returns consolidation failure", !first.success && (first.error ?? "").includes("Consolidate"), first.error ?? "");
let terminal: Awaited<ReturnType<typeof small.add>> | undefined;
for (let i = 0; i < 4; i++) terminal = await small.add("memory", "y".repeat(200));
assert("per-turn failure cap is terminal", !!terminal?.done, JSON.stringify(terminal));
setMemoryRoot(TMP);
await fs.rm(SMALLTMP, { recursive: true, force: true });

// injection block format (Hermes headers)
const block = store.formatBlock("memory");
assert("memory block has Hermes header", block.includes("MEMORY (your personal notes)") && block.includes("durable fact A"), block.slice(0, 80));
assert("user block has Hermes header", store.formatForSystemPrompt().includes("USER PROFILE (who the user is)"));

// § splitter tolerates legacy "-->§\n"
assert("splitter tolerates legacy separator", splitEntries("a -->§\nb").length === 2);

// review operation parsing (memory + skills)
const parsed = extractOperations('```json\n{"operations":[{"action":"add","target":"memory","content":"x"}],"skills":[{"action":"create","name":"s"}]}\n```');
assert("extractOperations parses memory + skills", parsed.operations.length === 1 && parsed.skills.length === 1 && !parsed.error, parsed.error ?? "");
assert("extractOperations rejects junk", !!extractOperations("no json here").error);

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
