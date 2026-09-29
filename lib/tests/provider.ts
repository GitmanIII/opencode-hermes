/**
 * opencode-hermes — memory-provider slot harness (hermetic).
 * Reference sqlite provider: add/search/prefetch/forget + onMemoryWrite mirror,
 * and the MemoryManager surface when a provider is present or absent.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createProvider } from "../memory-provider.ts";
import { MemoryManager } from "../memory-manager.ts";
import { SqliteMemoryProvider } from "../providers/sqlite-memory.ts";

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
const a = provider.add("The detector uses BirdNET for dove scoring");
provider.add("Field pulls go over MTP without adb");
provider.add("Unrelated postgres backup note");
assert("add returns an id", typeof a.id === "string" && a.id.startsWith("pm_"));

const hits = provider.search("BirdNET dove", 5);
assert("search finds the relevant note", hits.length >= 1 && hits[0].text.includes("BirdNET"), JSON.stringify(hits.map((h) => h.score)));
assert("search ignores unrelated notes", !hits.some((h) => h.text.includes("postgres")));

const pf = await provider.prefetch("how does birdnet score doves");
assert("prefetch returns a provider-memory block", pf.hits >= 1 && pf.text.includes("<provider-memory") && pf.text.includes("BirdNET"));
assert("prefetch empty for no match", (await provider.prefetch("zzzzqqqq")).hits === 0);

// onMemoryWrite mirror (dedup)
await provider.onMemoryWrite("add", "The detector uses BirdNET for dove scoring");
assert("mirror dedupes identical text", provider.search("BirdNET", 10).filter((h) => h.text === "The detector uses BirdNET for dove scoring").length === 1);
await provider.onMemoryWrite("add", "A brand new mirrored fact about caching");
assert("mirror adds new text", provider.search("caching", 5).length === 1);
await provider.onMemoryWrite("remove", "whatever");
assert("mirror ignores removes", provider.search("caching", 5).length === 1);

// systemPromptBlock + forget
assert("systemPromptBlock mentions the provider", provider.systemPromptBlock().includes("sqlite"));
const id = provider.search("caching", 5)[0].id;
provider.forget(id);
assert("forget removes the note", provider.search("caching", 5).length === 0);
provider.shutdown();

// manager
const noneMgr = new MemoryManager(null);
assert("manager with no provider prefetches nothing", (await noneMgr.prefetch("anything")) === "");
assert("manager activeName 'none'", noneMgr.activeName() === "none");

const p2 = new SqliteMemoryProvider();
await p2.initialize({ memoryRoot: TMP, providerPath, prefetchLimit: 5 });
const mgr = new MemoryManager(p2);
assert("manager prefetches when a provider is active", (await mgr.prefetch("birdnet doves")).includes("provider-memory"));
assert("manager mirrors writes", (await mgr.onMemoryWrite("add", "manager mirrored note"), mgr.search("mirrored").length) === 1);
mgr.shutdown();

await fs.rm(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
