/**
 * opencode-hermes — learning efficacy harness (mocked model).
 * Does the review write the RIGHT things and reject the WRONG things?
 *   - duplicate memory add   -> idempotent, no second copy
 *   - new memory add         -> written
 *   - protected user skill   -> patch rejected, unchanged
 *   - agent-created skill    -> patch applied; new skill created
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runBackgroundReview } from "../learn.ts";
import { setMemoryRoot, setSkillsRoot } from "../paths.ts";
import { manageSkill } from "../skills.ts";
import { MemoryStore } from "../store.ts";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-eff-"));
const SK = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-eff-skills-"));
setMemoryRoot(TMP);
setSkillsRoot(SK);

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
const exists = async (p: string) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const store = new MemoryStore({});
await store.loadFromDisk();
await store.add("memory", "existing durable fact");

await manageSkill(SK, { action: "create", name: "agent-skill", content: "---\nname: agent-skill\ndescription: Agent skill.\n---\n\n# Agent Skill\n\nOriginal.\n" });
await fs.mkdir(path.join(SK, "user-skill"), { recursive: true });
await fs.writeFile(path.join(SK, "user-skill", "SKILL.md"), "---\nname: user-skill\ndescription: User skill.\n---\n\n# User Skill\n\nOriginal.\n", "utf-8");

const CANNED = JSON.stringify({
  operations: [
    { action: "add", target: "memory", content: "existing durable fact" },
    { action: "add", target: "memory", content: "brand new durable fact" },
  ],
  skills: [
    { action: "patch", name: "user-skill", old_string: "Original.", new_string: "HACKED" },
    { action: "patch", name: "agent-skill", old_string: "Original.", new_string: "Improved." },
    { action: "create", name: "brand-new-skill", category: "testing", content: "---\nname: brand-new-skill\ndescription: Brand new skill.\n---\n\n# Brand New\n\nBody.\n" },
  ],
});

const client = {
  session: {
    messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "do the thing" }] }] }),
    create: async () => ({ data: { id: "ses_i" } }),
    prompt: async () => ({ data: { parts: [{ type: "text", text: CANNED }] } }),
    delete: async () => ({ data: {} }),
    get: async () => ({ data: { id: "ses_live", title: "live" } }),
  },
  tui: { showToast: async () => {} },
};

const res = await runBackgroundReview(client as any, store, "/tmp", "proj", "ses_eff", SK);
await new Promise((r) => setTimeout(r, 120));

const mem = await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8");
assert("duplicate memory not written twice", (mem.match(/existing durable fact/g) ?? []).length === 1);
assert("new memory written", mem.includes("brand new durable fact"));

assert("protected user skill unchanged", (await fs.readFile(path.join(SK, "user-skill", "SKILL.md"), "utf-8")).includes("Original."));
assert("agent skill patched", (await fs.readFile(path.join(SK, "agent-skill", "SKILL.md"), "utf-8")).includes("Improved."));
assert("new skill created", await exists(path.join(SK, "testing", "brand-new-skill", "SKILL.md")));
assert("protected rejection reported", (res.error ?? "").includes("protected"), res.error ?? "");
assert("savedSkills counts applied skill ops", res.savedSkills === 2, `savedSkills=${res.savedSkills}`);

await fs.rm(TMP, { recursive: true, force: true });
await fs.rm(SK, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
