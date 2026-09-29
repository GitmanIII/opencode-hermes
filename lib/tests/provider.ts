/**
 * opencode-hermes — memory-provider slot harness (hermetic).
 * Reference sqlite provider: add/search/prefetch/forget + onMemoryWrite mirror,
 * and the MemoryManager surface when a provider is present or absent.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyOperations } from "../learn.ts";
import { createProvider } from "../memory-provider.ts";
import { MemoryManager } from "../memory-manager.ts";
import { setMemoryRoot } from "../paths.ts";
import { SqliteMemoryProvider } from "../providers/sqlite-memory.ts";
import { MemoryStore } from "../store.ts";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-prov-"));
const providerPath = path.join(TMP, "provider.sqlite");

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

// registry
assert("createProvider('none') returns null", createProvider("none") === null);
assert("createProvider('sqlite') returns a provider", createProvider("sqlite")?.name === "sqlite");

// provider
const provider = new SqliteMemoryProvider();
await provider.initialize({ memoryRoot: TMP, providerPath, prefetchLimit: 5 });
const a = await provider.add("The detector uses BirdNET for dove scoring");
await provider.add("Field pulls go over MTP without adb");
await provider.add("Unrelated postgres backup note");
assert("add returns an id", typeof a.id === "string" && a.id.startsWith("pm_"));

const hits = await provider.search("BirdNET dove", 5);
assert("search finds the relevant note", hits.length >= 1 && hits[0].text.includes("BirdNET"), JSON.stringify(hits.map((h) => h.score)));
assert("search ignores unrelated notes", !hits.some((h) => h.text.includes("postgres")));

const pf = await provider.prefetch("how does birdnet score doves");
assert("prefetch returns a provider-memory block", pf.hits >= 1 && pf.text.includes("<provider-memory") && pf.text.includes("BirdNET"));
assert("prefetch empty for no match", (await provider.prefetch("zzzzqqqq")).hits === 0);

// onMemoryWrite mirror: add (dedup), replace (supersede), remove (delete), demote (keep)
await provider.onMemoryWrite("add", "The detector uses BirdNET for dove scoring");
assert("mirror dedupes identical text", (await provider.search("BirdNET", 10)).filter((h) => h.text === "The detector uses BirdNET for dove scoring").length === 1);
await provider.onMemoryWrite("add", "A brand new mirrored fact about caching");
assert("mirror adds new text", (await provider.search("caching", 5)).length === 1);
await provider.onMemoryWrite("replace", "The detector uses BirdNET for dove scoring and calibration", "The detector uses BirdNET for dove scoring");
assert("mirror replace deletes the old text", (await provider.search("BirdNET", 10)).every((h) => h.text !== "The detector uses BirdNET for dove scoring"));
assert("mirror replace adds the new text", (await provider.search("calibration", 5)).some((h) => h.text === "The detector uses BirdNET for dove scoring and calibration"));
await provider.onMemoryWrite("remove", "A brand new mirrored fact about caching");
assert("mirror remove deletes the note", (await provider.search("caching", 5)).length === 0);
await provider.onMemoryWrite("add", "A low-priority fact that gets demoted");
await provider.onMemoryWrite("demote", "A low-priority fact that gets demoted");
assert("mirror demote keeps the note", (await provider.search("low-priority demoted", 5)).some((h) => h.text === "A low-priority fact that gets demoted"));

// systemPromptBlock + forget
assert("systemPromptBlock mentions the provider", provider.systemPromptBlock().includes("sqlite"));
const id = (await provider.search("low-priority demoted", 5))[0].id;
provider.forget(id);
assert("forget removes the note", (await provider.search("low-priority demoted", 5)).length === 0);
provider.shutdown();

// manager
const noneMgr = new MemoryManager(null);
assert("manager with no provider prefetches nothing", (await noneMgr.prefetch("anything")) === "");
assert("manager activeName 'none'", noneMgr.activeName() === "none");

const p2 = new SqliteMemoryProvider();
await p2.initialize({ memoryRoot: TMP, providerPath, prefetchLimit: 5 });
const mgr = new MemoryManager(p2);
assert("manager prefetches when a provider is active", (await mgr.prefetch("birdnet doves")).includes("provider-memory"));
await mgr.onMemoryWrite("add", "manager mirrored note");
assert("manager mirrors writes", (await mgr.search("mirrored")).length === 1);
mgr.shutdown();

// The background/flush review path (applyOperations) must mirror too, not just
// the explicit memory tool. Regression for review writes never reaching the store.
const revTMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-rev-"));
setMemoryRoot(revTMP);
const revStore = new MemoryStore({});
await revStore.loadFromDisk();
const revProv = new SqliteMemoryProvider();
await revProv.initialize({ memoryRoot: revTMP, providerPath: path.join(revTMP, "rev.sqlite"), prefetchLimit: 5 });
const revMgr = new MemoryManager(revProv);
await applyOperations(revStore, [{ action: "add", content: "review fact one" }], revMgr);
assert("review path mirrors adds", (await revMgr.search("review fact one")).length === 1);
await applyOperations(revStore, [{ action: "replace", old_text: "review fact one", content: "review fact one corrected" }], revMgr);
assert("review path mirrors replace (old deleted)", (await revMgr.search("review fact one", 10)).every((h) => h.text !== "review fact one"));
assert("review path mirrors replace (new added)", (await revMgr.search("review fact corrected", 10)).some((h) => h.text === "review fact one corrected"));
await applyOperations(revStore, [{ action: "remove", old_text: "review fact one corrected" }], revMgr);
assert("review path mirrors remove", (await revMgr.search("review fact corrected", 10)).length === 0);
await applyOperations(revStore, [{ action: "add", content: "review demote me" }, { action: "demote", old_text: "review demote me" }], revMgr);
assert("review path mirrors demote (kept)", (await revMgr.search("review demote me", 10)).some((h) => h.text === "review demote me"));
revMgr.shutdown();
await fs.rm(revTMP, { recursive: true, force: true });
setMemoryRoot(TMP);

// Regression: manager must AWAIT async providers (embeddings), not return a Promise,
// else the provider_memory tool JSON.stringifies a Promise to "{}".
const asyncProvider = {
  name: "asyncfake",
  initialize: async () => {},
  systemPromptBlock: () => "",
  prefetch: async () => ({ text: "", hits: 0 }),
  add: async () => ({ id: "id1" }),
  search: async () => [{ id: "id1", text: "x", score: 1 }],
  forget: async () => true,
  onMemoryWrite: async () => {},
  shutdown: () => {},
};
const amgr = new MemoryManager(asyncProvider as never);
assert("manager awaits async provider search", (await amgr.search("q")).length === 1);
assert("manager awaits async provider add", (await amgr.add("x"))?.id === "id1");

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
