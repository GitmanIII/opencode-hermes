/**
 * opencode-hermes — self-learning loop harness (mocked model).
 * A) runBackgroundReview directly: canned ops → memory (memory+user) + skill.
 * B) Through the real plugin: N turns → session.idle → review writes memory.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runBackgroundReview } from "../learn.ts";
import { setMemoryRoot, setSkillsRoot } from "../paths.ts";
import { MemoryStore } from "../store.ts";

process.env.HERMES_NUDGE_INTERVAL = "2";
process.env.HERMES_OPENCODE_LOG = path.join(os.tmpdir(), "opencode-hermes-test.log");

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
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const exists = async (p: string) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const SKILL_CONTENT = "---\nname: self-learning-skill\ndescription: Harness-created skill.\n---\n\n# Self Learning Skill\n\nBody.\n";
const CANNED = JSON.stringify({
  operations: [
    { action: "add", target: "memory", content: "self-learning test: use 4-space indent" },
    { action: "add", target: "user", content: "self-learning test: prefers short answers" },
  ],
  skills: [{ action: "create", name: "self-learning-skill", category: "testing", content: SKILL_CONTENT }],
});

function mockClient() {
  let created = 0;
  const calls: any[] = [];
  return {
    _created: () => created,
    _calls: calls,
    session: {
      messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "please use 4-space indent" }] }] }),
      create: async () => {
        created++;
        calls.push("create");
        return { data: { id: `ses_i_${created}` } };
      },
      prompt: async (a: any) => {
        calls.push(a);
        return { data: { parts: [{ type: "text", text: CANNED }] } };
      },
      delete: async () => ({ data: {} }),
      get: async () => ({ data: { id: "ses_live", title: "live" } }),
    },
    tui: { showToast: async () => calls.push("toast") },
  };
}

// ── Level A ──
{
  const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-sl-a-"));
  const SKA = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-sl-skills-a-"));
  setMemoryRoot(TMP);
  setSkillsRoot(SKA);
  const store = new MemoryStore({});
  await store.loadFromDisk();
  const client = mockClient();

  const res = await runBackgroundReview(client as any, store, "/tmp", "sample-project", "ses_live", SKA);
  assert("review reports no error", !res.error, res.error ?? "");
  assert("review saved 2 memory + 1 skill", res.savedCount === 3 && res.savedSkills === 1, `saved=${res.savedCount} skills=${res.savedSkills}`);
  await tick();
  assert("memory op landed", (await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8")).includes("use 4-space indent"));
  assert("user op landed", (await fs.readFile(path.join(TMP, "USER.md"), "utf-8")).includes("prefers short answers"));
  assert("skill op created file", await exists(path.join(SKA, "testing", "self-learning-skill", "SKILL.md")));

  const before = client._created();
  const res2 = await runBackgroundReview(client as any, store, "/tmp", "sample-project", "ses_live", SKA);
  assert("second review is a no-op", res2.savedCount === 0 && client._created() === before, `saved=${res2.savedCount}`);

  await tick();
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.rm(SKA, { recursive: true, force: true });
}

// ── Level B ──
{
  const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-sl-b-"));
  const SKB = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-sl-skills-b-"));
  setMemoryRoot(TMP);
  setSkillsRoot(SKB);
  const pluginModule = (await import("../../index.ts")).default;
  const client = mockClient();
  const hooks: any = await pluginModule.server({ client, project: { id: "sample-project" }, directory: "/home/emil/sample-project" } as any);

  await hooks["chat.message"]({ sessionID: "ses_live_b" }, { parts: [{ type: "text", text: "hello" }] });
  await hooks["chat.message"]({ sessionID: "ses_live_b" }, { parts: [{ type: "text", text: "again" }] });

  const before = client._created();
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_live_b" } } });
  await tick(11_500);

  assert("idle trigger ran a review", client._created() > before, `${before}->${client._created()}`);
  assert("idle review wrote memory", (await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8")).includes("use 4-space indent"));
  assert("idle review created skill", await exists(path.join(SKB, "testing", "self-learning-skill", "SKILL.md")));
  assert("idle review toasted", client._calls.includes("toast"));

  await tick();
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.rm(SKB, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
