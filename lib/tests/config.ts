/**
 * opencode-hermes — config harness (hermetic).
 * Verifies Hermes-parity defaults and env/file override precedence.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configWarnings, HERMES_DEFAULTS, loadConfig } from "../config.ts";
import { setMemoryRoot } from "../paths.ts";
import { MemoryStore } from "../store.ts";

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

const ENV_KEYS = [
  "HERMES_OPENCODE_MEMORY_LIMIT",
  "HERMES_OPENCODE_USER_LIMIT",
  "HERMES_NUDGE_INTERVAL",
  "HERMES_OPENCODE_PROVIDER",
  "HERMES_OPENCODE_CONFIG",
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) {
  saved[k] = process.env[k];
  delete process.env[k];
}
// Hermetic: point at a non-existent config so defaults checks never read the
// user's real ~/.config/opencode/opencode-hermes.json.
process.env.HERMES_OPENCODE_CONFIG = path.join(os.tmpdir(), `hermes-cfg-missing-${process.pid}.json`);

assert("default memory limit is 2200 (Hermes)", HERMES_DEFAULTS.memoryCharLimit === 2200);
assert("default user limit is 1375 (Hermes)", HERMES_DEFAULTS.userCharLimit === 1375);
const base = loadConfig();
assert("loadConfig defaults match Hermes", base.memoryCharLimit === 2200 && base.userCharLimit === 1375, JSON.stringify(base));
assert("provider defaults to none (Hermes built-in only)", base.provider === "none", base.provider);
process.env.HERMES_OPENCODE_PROVIDER = "sqlite";
assert("env selects a provider", loadConfig().provider === "sqlite", loadConfig().provider);
delete process.env.HERMES_OPENCODE_PROVIDER;

process.env.HERMES_OPENCODE_MEMORY_LIMIT = "5000";
assert("env overrides memory limit", loadConfig().memoryCharLimit === 5000, String(loadConfig().memoryCharLimit));
delete process.env.HERMES_OPENCODE_MEMORY_LIMIT;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cfg-"));
const cfgPath = path.join(dir, "opencode-hermes.json");
await fs.writeFile(cfgPath, `{\n  // comment tolerated\n  "userCharLimit": 900,\n  "nudgeInterval": 3\n}\n`, "utf-8");
process.env.HERMES_OPENCODE_CONFIG = cfgPath;
assert("file overrides user limit", loadConfig().userCharLimit === 900, String(loadConfig().userCharLimit));
assert("file overrides nudge", loadConfig().nudgeInterval === 3, String(loadConfig().nudgeInterval));

// regression: JSONC stripper must not eat `file:///` URLs or inline comments
await fs.writeFile(cfgPath, `{\n  "provider": "file:///home/me/opencode-hermes-embeddings/src/provider.ts", // inline\n  "providerOptions": { "endpoint": "http://127.0.0.1:8080" }\n}\n`, "utf-8");
const urlCfg = loadConfig();
assert("file:// provider URL survives JSONC strip", urlCfg.provider === "file:///home/me/opencode-hermes-embeddings/src/provider.ts", urlCfg.provider);
assert("nested providerOptions parse", (urlCfg.providerOptions as { endpoint?: string }).endpoint === "http://127.0.0.1:8080", JSON.stringify(urlCfg.providerOptions));

// JSONC robustness: string contents survive; trailing commas and tight comments parse.
await fs.writeFile(
  cfgPath,
  `{
  "nudgeInterval": 3,// tight comment (no space before //)
  "providerOptions": {
    "glob": "src/**/*.ts",
    "note": "a // b and http://x /* y",
    "list": [1, 2,],
  },
}\n`,
  "utf-8",
);
const jsoncCfg = loadConfig();
const po = jsoncCfg.providerOptions as { glob?: string; note?: string; list?: number[] };
assert("JSONC: glob with /* survives", po.glob === "src/**/*.ts", String(po.glob));
assert("JSONC: // and /* inside strings survive", po.note === "a // b and http://x /* y", String(po.note));
assert("JSONC: trailing commas stripped", Array.isArray(po.list) && po.list.length === 2, JSON.stringify(po.list));
assert("JSONC: trailing comma before } parses", jsoncCfg.nudgeInterval === 3, String(jsoncCfg.nudgeInterval));
process.env.HERMES_OPENCODE_USER_LIMIT = "777";
assert("env beats file", loadConfig().userCharLimit === 777, String(loadConfig().userCharLimit));
delete process.env.HERMES_OPENCODE_USER_LIMIT;

// an unparseable config file used to fail silently; it now warns and defaults
await fs.writeFile(cfgPath, "{ bad json // comment\n", "utf-8");
loadConfig();
assert("invalid config warns and falls back to defaults", configWarnings().length === 1 && configWarnings()[0].includes("invalid JSONC"), JSON.stringify(configWarnings()));
delete process.env.HERMES_OPENCODE_CONFIG;

const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cfg-store-"));
setMemoryRoot(storeRoot);
const store = new MemoryStore({ memoryCharLimit: 200 });
await store.loadFromDisk();
assert("store reports configured limit", store.usage("memory").includes("/200 chars"), store.usage("memory"));
const r = await store.add("memory", "x".repeat(300));
assert("store rejects overflow past configured limit", !r.success, r.error ?? "");

for (const k of ENV_KEYS) {
  if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
}

await fs.rm(dir, { recursive: true, force: true });
await fs.rm(storeRoot, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
