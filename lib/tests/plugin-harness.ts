/**
 * opencode-hermes — plugin wiring harness (hermetic, no LLM).
 * Drives the real plugin hooks with a mock client: whole-file memory
 * injection, the single `memory` tool, and the skill tools.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setMemoryRoot, setSkillsRoot } from "../paths.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "fixtures", "sample-memory");

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-plugin-"));
const SKILLS = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-plugin-skills-"));
await fs.cp(FIXTURES, TMP, { recursive: true });
setMemoryRoot(TMP);
setSkillsRoot(SKILLS);
process.env.HERMES_OPENCODE_LOG = path.join(TMP, "test.log");

const pluginModule = (await import("../../index.ts")).default;

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

let sessionsCreated = 0;
const client = {
  session: {
    prompt: async () => ({ data: {} }),
    get: async () => ({ data: { id: "ses_t", title: "test" } }),
    messages: async () => ({ data: [] }),
    create: async () => {
      sessionsCreated++;
      return { data: { id: "ses_internal" } };
    },
    delete: async () => ({ data: {} }),
  },
  tui: { showToast: async () => {} },
};

const hooks: any = await pluginModule.server({ client, project: { id: "sample-project" }, directory: "/home/emil/sample-project" });

// 1. whole-file memory injection
const out = { system: [] as string[] };
await hooks["experimental.chat.system.transform"]({}, out);
const sys = out.system.join("\n");
assert("system prompt includes MEMORY block", sys.includes("MEMORY (your personal notes)") && sys.includes("pnpm build"), sys.slice(0, 120));
assert("system prompt includes USER block", sys.includes("USER PROFILE (who the user is)"));
assert("system prompt includes memory guidance", sys.includes("persistent memory across sessions"));

// 2. single memory tool: add + batch
const addRes = JSON.parse(String(await hooks.tool.memory.execute({ target: "memory", action: "add", content: "harness-added fact" }, {})));
assert("memory add succeeds", addRes.success === true, JSON.stringify(addRes));
const memFile = await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8");
assert("memory add persisted", memFile.includes("harness-added fact"));
const batchRes = JSON.parse(String(await hooks.tool.memory.execute({ target: "user", operations: [{ action: "add", content: "harness user pref" }] }, {})));
assert("memory batch succeeds", batchRes.success === true, JSON.stringify(batchRes));
assert("batch persisted to USER.md", (await fs.readFile(path.join(TMP, "USER.md"), "utf-8")).includes("harness user pref"));

// 3. skill tools
const skillContent = "---\nname: harness-skill\ndescription: Harness-created skill.\n---\n\n# Harness Skill\n\nBody.\n";
const created = JSON.parse(String(await hooks.tool.skill_manage.execute({ action: "create", name: "harness-skill", category: "testing", content: skillContent }, {})));
assert("skill_manage create succeeds", created.success === true, JSON.stringify(created));
const listed = JSON.parse(String(await hooks.tool.skill_list.execute({}, {})));
assert("skill_list finds created skill", listed.skills.some((s: any) => s.name === "harness-skill"), JSON.stringify(listed));
const viewed = JSON.parse(String(await hooks.tool.skill_view.execute({ name: "harness-skill" }, {})));
assert("skill_view returns content", viewed.success && viewed.content.includes("# Harness Skill"));

// 4. no model calls in this path
assert("no LLM session created", sessionsCreated === 0, String(sessionsCreated));

await fs.rm(TMP, { recursive: true, force: true });
await fs.rm(SKILLS, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
