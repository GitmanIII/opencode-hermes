/**
 * opencode-hermes — review consolidation harness (hermetic, mocked model).
 *
 * A full store must not silently swallow new facts. The background review states
 * the budget and retries ONCE with an explicit "make room" instruction when the
 * only reason nothing applied was the char limit. Regression: before this, every
 * review over a full store logged "produced no applicable operations" forever.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ReviewChannel, TranscriptMessage } from "../channel.ts";
import { runBackgroundReview } from "../learn.ts";
import { setMemoryRoot, setSkillsRoot } from "../paths.ts";
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

// ~2000 chars of entries (header included in the first block, as on disk) against
// the 2200 cap, so a 400-char add must overflow and force consolidation.
const ALPHA = "ALPHA-MARKER " + "a".repeat(990);
const BETA = "BETA-MARKER " + "b".repeat(991);
const FACT = "GAMMA-FACT " + "c".repeat(390);
const SEEDED = `MEMORY (your personal notes) [0% — 0/2200 chars]\n══════════════════════════\n${ALPHA}\n§\n${BETA}\n`;

const OVERFLOW_ADD = JSON.stringify({ operations: [{ action: "add", content: FACT }], skills: [] });
const CONSOLIDATE = JSON.stringify({ operations: [{ action: "demote", old_text: "ALPHA-MARKER" }, { action: "add", content: FACT }], skills: [] });

function channelWith(replies: string[]) {
  const prompts: string[] = [];
  let calls = 0;
  const channel: ReviewChannel = {
    async transcript(): Promise<TranscriptMessage[]> {
      return [{ role: "user", text: `for the record: ${FACT}` }];
    },
    async complete(_system, user) {
      prompts.push(user);
      const text = replies[Math.min(calls, replies.length - 1)];
      calls++;
      return { text };
    },
    async sessionTitle() {
      return "consolidation harness";
    },
    async injectNote() {},
    async toast() {},
  };
  return { channel, prompts, calls: () => calls };
}

async function freshStore(label: string) {
  const TMP = await fs.mkdtemp(path.join(os.tmpdir(), `hermes-consol-${label}-`));
  setMemoryRoot(TMP);
  await fs.writeFile(path.join(TMP, "MEMORY.md"), SEEDED);
  const store = new MemoryStore({});
  await store.loadFromDisk();
  return { TMP, store };
}

// ── 1. full store → one retry that makes room in the same batch ──
{
  const { TMP, store } = await freshStore("ok");
  const before = store.chars("memory");
  assert("seed fills the store close to the cap", before > 1900 && before <= 2200, `chars=${before}`);

  const { channel, prompts, calls } = channelWith([OVERFLOW_ADD, CONSOLIDATE]);
  const res = await runBackgroundReview(channel, store, "proj", "ses_consol");

  assert("initial prompt carries the budget", /<memory-budget>/.test(prompts[0] ?? "") && /2200 chars/.test(prompts[0] ?? ""));
  assert("review reports no error", !res.error, res.error ?? "");
  assert("new fact was saved via the retry", res.savedCount >= 1, `saved=${res.savedCount}`);
  assert("retry ran exactly once", calls() === 2, `calls=${calls()}`);
  assert("retry prompt lists entries with sizes", (prompts[1] ?? "").includes("<entries>") && (prompts[1] ?? "").includes("ALPHA-MARKER"), (prompts[1] ?? "").slice(0, 120));
  assert("retry prompt carries the make-room instruction", /Reissue ONE batch/.test(prompts[1] ?? ""));

  const file = await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8");
  assert("new fact persisted to MEMORY.md", file.includes("GAMMA-FACT"));
  assert("demoted entry left the file", !file.includes("ALPHA-MARKER"));
  assert("untouched entry kept", file.includes("BETA-MARKER"));
  assert("store is back under the cap", store.chars("memory") <= 2200, `chars=${store.chars("memory")}`);

  await fs.rm(TMP, { recursive: true, force: true });
}

// ── 2. retry that still overflows → surface the error, do not loop ──
{
  const { TMP, store } = await freshStore("fail");
  const { channel, calls } = channelWith([OVERFLOW_ADD, OVERFLOW_ADD]);
  const res = await runBackgroundReview(channel, store, "proj", "ses_fail");

  assert("persistent overflow reports the budget error", /exceed the limit/i.test(res.error ?? ""), res.error ?? "");
  assert("nothing was saved", res.savedCount === 0, `saved=${res.savedCount}`);
  assert("only one retry (no loop)", calls() === 2, `calls=${calls()}`);

  await fs.rm(TMP, { recursive: true, force: true });
}

// ── 3. a skill write or error must not suppress the memory retry ──
{
  const { TMP, store } = await freshStore("skill-ok");
  const SKILLS = path.join(TMP, "skills");
  await fs.mkdir(SKILLS, { recursive: true });
  setSkillsRoot(SKILLS);
  const SKILL = "---\nname: consolidation-skill\ndescription: test skill\n---\n\n# Test\n";
  const first = JSON.stringify({
    operations: [{ action: "add", content: FACT }],
    skills: [{ action: "create", name: "consolidation-skill", content: SKILL }],
  });
  const { channel, calls } = channelWith([first, CONSOLIDATE]);
  const res = await runBackgroundReview(channel, store, "proj", "ses_skill_ok", SKILLS);
  const file = await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8");
  assert("a successful skill does not suppress the memory retry", calls() === 2, `calls=${calls()}`);
  assert("memory fact is saved when a skill also applies", file.includes("GAMMA-FACT"), res.error ?? "");
  assert("the skill was applied once", await fs.stat(path.join(SKILLS, "consolidation-skill", "SKILL.md")).then(() => true, () => false));
  await fs.rm(TMP, { recursive: true, force: true });
}

{
  const { TMP, store } = await freshStore("skill-err");
  const SKILLS = path.join(TMP, "skills");
  await fs.mkdir(SKILLS, { recursive: true });
  setSkillsRoot(SKILLS);
  const first = JSON.stringify({
    operations: [{ action: "add", content: FACT }],
    skills: [{ action: "create", name: "bad name!", content: "---\nname: bad name!\ndescription: x\n---\n" }],
  });
  const { channel, calls } = channelWith([first, CONSOLIDATE]);
  const res = await runBackgroundReview(channel, store, "proj", "ses_skill_err", SKILLS);
  const file = await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8");
  assert("a skill error does not suppress the memory retry", calls() === 2, `calls=${calls()}`);
  assert("memory fact is saved despite the skill error", file.includes("GAMMA-FACT"), res.error ?? "");
  assert("the skill error is still reported", /invalid skill name/.test(res.error ?? ""), res.error ?? "");
  await fs.rm(TMP, { recursive: true, force: true });
}

// ── 4. one target blocks, the other succeeds → retry only the blocked target ──
{
  const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-consol-mixed-"));
  setMemoryRoot(TMP);
  const MFACT = "MEMORY-FACT " + "m".repeat(100);
  const UFACT = "USER-FACT " + "u".repeat(200);
  await fs.writeFile(
    path.join(TMP, "MEMORY.md"),
    `MEMORY (your personal notes) [0% — 0/2200 chars]\n══════════════════════════\nseed memory fact\n`,
  );
  await fs.writeFile(
    path.join(TMP, "USER.md"),
    `USER PROFILE (who the user is) [0% — 0/1375 chars]\n══════════════════════════\nUSER-ALPHA ${"a".repeat(600)}\n§\nUSER-BETA ${"b".repeat(600)}\n`,
  );
  const store = new MemoryStore({});
  await store.loadFromDisk();
  const first = JSON.stringify({
    operations: [
      { action: "add", target: "memory", content: MFACT },
      { action: "add", target: "user", content: UFACT },
    ],
    skills: [],
  });
  const retry = JSON.stringify({
    operations: [
      { action: "demote", target: "user", old_text: "USER-ALPHA" },
      { action: "add", target: "user", content: UFACT },
    ],
    skills: [],
  });
  const { channel, prompts, calls } = channelWith([first, retry]);
  const res = await runBackgroundReview(channel, store, "proj", "ses_mixed");
  const memoryFile = await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8");
  const userFile = await fs.readFile(path.join(TMP, "USER.md"), "utf-8");
  assert("the blocked target is retried", calls() === 2, `calls=${calls()}`);
  assert("retry names only the blocked target", /could not write to: user/.test(prompts[1] ?? ""), (prompts[1] ?? "").slice(0, 160));
  assert("the successful memory target is not re-applied", (memoryFile.match(/MEMORY-FACT/g) ?? []).length === 1, `count=${(memoryFile.match(/MEMORY-FACT/g) ?? []).length}`);
  assert("both facts are saved", memoryFile.includes(MFACT) && userFile.includes(UFACT), res.error ?? "");
  assert("user store is back under the cap", store.chars("user") <= 1375, `chars=${store.chars("user")}`);
  await fs.rm(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
