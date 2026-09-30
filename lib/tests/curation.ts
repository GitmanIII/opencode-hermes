/**
 * hermes-opencode — skill curation harness (hermetic).
 * Lifecycle: inactive AGENT-created skills go stale then archived; user skills
 * and pinned skills are never touched; archive is restorable.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { curateSkills, listSkills, manageSkill, readUsage, restoreSkill, setPinned } from "../skills.ts";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-curate-"));
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

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
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n\nBody.\n`;

await manageSkill(ROOT, { action: "create", name: "old-agent", content: skill("old-agent") });
await manageSkill(ROOT, { action: "create", name: "stale-agent", content: skill("stale-agent") });
await manageSkill(ROOT, { action: "create", name: "recent-agent", content: skill("recent-agent") });
await manageSkill(ROOT, { action: "create", name: "pinned-old", content: skill("pinned-old") });
await setPinned(ROOT, "pinned-old", true);
await fs.mkdir(path.join(ROOT, "user-skill"), { recursive: true });
await fs.writeFile(path.join(ROOT, "user-skill", "SKILL.md"), skill("user-skill"), "utf-8");

// rewind activity timestamps
const usage = await readUsage(ROOT);
usage["old-agent"] = { created_by: "agent", created_at: iso(100), last_patched_at: iso(100) };
usage["stale-agent"] = { created_by: "agent", created_at: iso(40), last_patched_at: iso(40) };
usage["pinned-old"] = { ...usage["pinned-old"], created_by: "agent", created_at: iso(100), last_patched_at: iso(100), pinned: true };
await fs.writeFile(path.join(ROOT, ".usage.json"), JSON.stringify(usage, null, 2), "utf-8");

// dry run
const dry = await curateSkills(ROOT, { dryRun: true });
assert("dry-run flags old-agent for archive", dry.archived.includes("old-agent"), JSON.stringify(dry));
assert("dry-run flags stale-agent stale", dry.stale.includes("stale-agent"), JSON.stringify(dry));
assert("dry-run moves nothing", !(await exists(path.join(ROOT, ".archive", "old-agent"))));

// real run
const real = await curateSkills(ROOT);
assert("old-agent archived", real.archived.includes("old-agent") && (await exists(path.join(ROOT, ".archive", "old-agent", "SKILL.md"))), JSON.stringify(real));
assert("stale-agent marked stale (not archived)", real.stale.includes("stale-agent") && (await exists(path.join(ROOT, "stale-agent", "SKILL.md"))));
assert("recent-agent untouched", !real.archived.includes("recent-agent") && (await exists(path.join(ROOT, "recent-agent", "SKILL.md"))));
assert("user skill untouched", !real.archived.includes("user-skill") && (await exists(path.join(ROOT, "user-skill", "SKILL.md"))));
assert("pinned skill untouched", !real.archived.includes("pinned-old") && (await exists(path.join(ROOT, "pinned-old", "SKILL.md"))));
assert("archived skill not in active list", !(await listSkills(ROOT)).some((s) => s.name === "old-agent"));

const after = await readUsage(ROOT);
assert("usage state recorded", after["old-agent"].state === "archived" && after["stale-agent"].state === "stale");

const restored = await restoreSkill(ROOT, "old-agent");
assert("restore moves skill back", restored.success && (await exists(path.join(ROOT, "old-agent", "SKILL.md"))));
const afterRestore = await readUsage(ROOT);
assert("restore clears archived state", afterRestore["old-agent"].state === "active");

// a corrupt .usage.json is preserved (moved aside), not silently overwritten
const CORRUPT = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-usage-corrupt-"));
await fs.writeFile(path.join(CORRUPT, ".usage.json"), "{not json", "utf-8");
const recovered = await readUsage(CORRUPT);
assert("corrupt usage file returns empty", Object.keys(recovered).length === 0);
assert("corrupt usage file is moved aside", (await fs.readdir(CORRUPT)).some((f) => f.startsWith(".usage.json.corrupt-")));
await fs.rm(CORRUPT, { recursive: true, force: true });

await fs.rm(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
