/**
 * opencode-hermes — review token-cost harness (mocked model).
 * Measures the prompt the background review sends per idle run: system prompt
 * + user prompt (instructions + transcript + existing memory/skills).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runBackgroundReview } from "../learn.ts";
import { setMemoryRoot, setSkillsRoot } from "../paths.ts";
import { manageSkill } from "../skills.ts";
import { MemoryStore } from "../store.ts";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cost-"));
const SK = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cost-skills-"));
setMemoryRoot(TMP);
setSkillsRoot(SK);

let passed = 0;
let failed = 0;
const assert = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++;
  else {
    failed++;
    console.log(`❌ ${name} ${detail}`);
  }
};

const store = new MemoryStore({});
await store.loadFromDisk();
await store.add("memory", "some existing memory fact");
await manageSkill(SK, { action: "create", name: "existing-skill", content: "---\nname: existing-skill\ndescription: An existing skill.\n---\n\n# Existing\n\nBody.\n" });

function makeClient(messages: any[]) {
  let captured: any = null;
  return {
    _captured: () => captured,
    session: {
      messages: async () => ({ data: messages }),
      create: async () => ({ data: { id: "ses_i" } }),
      prompt: async (a: any) => {
        captured = a;
        return { data: { parts: [{ type: "text", text: '{"operations":[],"skills":[]}' }] } };
      },
      delete: async () => ({ data: {} }),
      get: async () => ({ data: { id: "ses_live", title: "live" } }),
    },
    tui: { showToast: async () => {} },
  };
}
function msgs(n: number, chars: number) {
  return Array.from({ length: n }, (_, i) => ({
    info: { role: i % 2 ? "assistant" : "user", modelID: "m" },
    parts: [{ type: "text", text: `message ${i} ${"x".repeat(chars)}` }],
  }));
}

const TOK = (s: number) => Math.round(s / 4);
console.log("=== background review prompt cost (system + user) ===");
console.log("scenario            messages  prompt_chars  ~prompt_tokens");
const scenarios: [string, any[]][] = [
  ["small (10×300)", msgs(10, 300)],
  ["typical (40×500)", msgs(40, 500)],
  ["large (300×1000)", msgs(300, 1000)],
];
let largeChars = 0;
for (const [label, messages] of scenarios) {
  const client = makeClient(messages);
  await runBackgroundReview(client as any, store, "/tmp", "proj", `ses_${label}`, SK);
  const cap = client._captured();
  const chars = (cap?.body?.parts ?? []).reduce((a: number, p: any) => a + (p.text?.length ?? 0), 0);
  if (label.startsWith("large")) largeChars = chars;
  console.log(`${label.padEnd(20)} ${String(messages.length).padStart(6)}  ${String(chars).padStart(11)}  ${String(TOK(chars)).padStart(14)}`);
}

assert("large prompt bounded by transcript cap (< 40000 chars)", largeChars > 0 && largeChars < 40_000, `chars=${largeChars}`);
assert("large prompt smaller than raw input", largeChars < 300 * 1000, `chars=${largeChars}`);

await fs.rm(TMP, { recursive: true, force: true });
await fs.rm(SK, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
