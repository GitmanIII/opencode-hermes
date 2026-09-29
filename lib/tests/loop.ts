/**
 * opencode-hermes — memory loop harness (hermetic).
 * Loads the sample MEMORY.md/USER.md fixtures and exercises load → inject →
 * mutate on the Hermes-core store.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setMemoryRoot } from "../paths.ts";
import { MemoryStore } from "../store.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "fixtures", "sample-memory");

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-loop-"));
await fs.cp(FIXTURES, TMP, { recursive: true });
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

const store = new MemoryStore({});
await store.loadFromDisk();

assert("MEMORY.md loads 3 entries", store.entryCount("memory") === 3, String(store.entryCount("memory")));
assert("USER.md loads 2 entries", store.entryCount("user") === 2, String(store.entryCount("user")));

const injected = store.formatForSystemPrompt();
assert("injection contains MEMORY header + fact", injected.includes("MEMORY (your personal notes)") && injected.includes("pnpm build"));
assert("injection contains USER header + fact", injected.includes("USER PROFILE (who the user is)") && injected.includes("concise answers"));

const r = await store.add("memory", "New fact captured during the session.");
assert("add persists to disk", r.success && (await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8")).includes("New fact captured"));
assert("entry count grows", store.entryCount("memory") === 4);

const r2 = await store.replace("memory", "New fact captured", "New fact (revised).");
assert("replace persists", r2.success && (await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8")).includes("New fact (revised)."));

const r3 = await store.remove("user", "Works in UTC+1");
assert("remove from user persists", r3.success && !(await fs.readFile(path.join(TMP, "USER.md"), "utf-8")).includes("UTC+1"));

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
