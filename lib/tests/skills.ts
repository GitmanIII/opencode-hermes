/**
 * hermes-opencode — skills subsystem harness (hermetic, no model).
 * Exercises create/validate/list/view/patch/write_file/delete, guards, and
 * usage/provenance against a temp skills root.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySkillOperations,
  bumpUsage,
  listSkills,
  manageSkill,
  parseFrontmatter,
  provenance,
  resolveSkillDir,
  viewSkill,
} from "../skills.ts";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-skills-"));

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

const VALID = `---
name: test-skill
description: Test skill for the harness.
version: 0.1.0
---

# Test Skill

Body text here.
`;

// 1. create
let r = await manageSkill(ROOT, { action: "create", name: "test-skill", category: "testing", content: VALID });
assert("create succeeds", r.success, r.error ?? "");
assert("SKILL.md written", await exists(path.join(ROOT, "testing", "test-skill", "SKILL.md")));
assert("provenance is agent", (await provenance(ROOT, "test-skill")) === "agent");

// 2. validation rejections
assert("reject bad name", !(await manageSkill(ROOT, { action: "create", name: "Bad Name", content: VALID })).success);
assert(
  "reject missing description",
  !(await manageSkill(ROOT, { action: "create", name: "no-desc", content: "---\nname: no-desc\n---\n\nbody\n" })).success,
);
assert(
  "reject empty body",
  !(await manageSkill(ROOT, { action: "create", name: "no-body", content: "---\nname: no-body\ndescription: x.\n---\n\n" })).success,
);
assert("reject duplicate create", !(await manageSkill(ROOT, { action: "create", name: "test-skill", content: VALID })).success);

// 3. list / resolve / view
const skills = await listSkills(ROOT);
assert("list finds the skill with category", skills.length === 1 && skills[0].category === "testing" && skills[0].name === "test-skill");
assert("resolve by name", !!(await resolveSkillDir(ROOT, "test-skill")).dir);
const v = await viewSkill(ROOT, "test-skill");
assert("view returns content", v.success && (v.content ?? "").includes("# Test Skill"));

// 4. patch
r = await manageSkill(ROOT, { action: "patch", name: "test-skill", oldString: "Body text here.", newString: "Body text updated." });
assert("patch succeeds", r.success, r.error ?? "");
assert("patch persisted", (await fs.readFile(path.join(ROOT, "testing", "test-skill", "SKILL.md"), "utf-8")).includes("Body text updated."));
assert("patch rejects empty old_string", !(await manageSkill(ROOT, { action: "patch", name: "test-skill", oldString: "", newString: "X" })).success);
r = await manageSkill(ROOT, { action: "patch", name: "test-skill", oldString: "Body text updated.", newString: "costs $5 & $$ and $& literal" });
assert(
  "patch keeps $ patterns literal in new_string",
  r.success && (await fs.readFile(path.join(ROOT, "testing", "test-skill", "SKILL.md"), "utf-8")).includes("costs $5 & $$ and $& literal"),
  r.error ?? "",
);

// 5. support files + guards
r = await manageSkill(ROOT, { action: "write_file", name: "test-skill", filePath: "references/notes.md", fileContent: "ref notes" });
assert("write_file under references succeeds", r.success, r.error ?? "");
r = await manageSkill(ROOT, { action: "write_file", name: "test-skill", filePath: "evil.md", fileContent: "x" });
assert("write_file outside support dir rejected", !r.success);
r = await manageSkill(ROOT, { action: "write_file", name: "test-skill", filePath: "../escape.md", fileContent: "x" });
assert("write_file traversal rejected", !r.success);
const v2 = await viewSkill(ROOT, "test-skill");
assert("view lists linked files", (v2.linkedFiles ?? []).includes("references/notes.md"), JSON.stringify(v2.linkedFiles));
r = await manageSkill(ROOT, { action: "remove_file", name: "test-skill", filePath: "references/notes.md" });
assert("remove_file under references succeeds", r.success && !(await exists(path.join(ROOT, "testing", "test-skill", "references", "notes.md"))), r.error ?? "");
r = await manageSkill(ROOT, { action: "remove_file", name: "test-skill", filePath: "SKILL.md" });
assert("remove_file refuses SKILL.md", !r.success && (r.error ?? "").includes("support files"), r.error ?? "");
r = await manageSkill(ROOT, { action: "remove_file", name: "test-skill", filePath: "../escape.md" });
assert("remove_file traversal rejected", !r.success);
assert("SKILL.md survives a refused remove_file", await exists(path.join(ROOT, "testing", "test-skill", "SKILL.md")));

// 6. usage sidecar
await bumpUsage(ROOT, "test-skill", "use");
const usage = JSON.parse(await fs.readFile(path.join(ROOT, ".usage.json"), "utf-8"));
assert("usage records use + provenance", usage["test-skill"].use_count === 1 && usage["test-skill"].created_by === "agent");

// 7. delete
r = await manageSkill(ROOT, { action: "delete", name: "test-skill" });
assert("delete succeeds", r.success, r.error ?? "");
assert("skill dir gone", !(await exists(path.join(ROOT, "testing", "test-skill"))));

// 8. frontmatter parser sanity
assert("parser rejects no frontmatter", !!parseFrontmatter("# hi\n").error);
assert("parser accepts quoted description", !!parseFrontmatter('---\nname: q\ndescription: "has: colon."\n---\n\nbody\n').fm);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// 9. background-review guard: cannot touch non-agent skills
await fs.mkdir(path.join(ROOT, "user-owned"), { recursive: true });
await fs.writeFile(
  path.join(ROOT, "user-owned", "SKILL.md"),
  "---\nname: user-owned\ndescription: Hand-authored skill.\n---\n\n# User Owned\n\nOriginal body.\n",
  "utf-8",
);
const guard = await applySkillOperations(
  ROOT,
  [{ action: "patch", name: "user-owned", old_string: "Original body.", new_string: "HACKED" }],
  { origin: "agent" },
);
assert("review cannot patch non-agent skill", guard.errors.length === 1 && guard.applied === 0, JSON.stringify(guard));
const userAfter = await fs.readFile(path.join(ROOT, "user-owned", "SKILL.md"), "utf-8");
assert("non-agent skill unchanged", userAfter.includes("Original body.") && !userAfter.includes("HACKED"));
const fg = await applySkillOperations(
  ROOT,
  [{ action: "patch", name: "user-owned", old_string: "Original body.", new_string: "Foreground edit." }],
  { origin: "foreground" },
);
assert("foreground may patch non-agent skill", fg.applied === 1, JSON.stringify(fg));

// 10. agent-created skills ARE editable by the review
await manageSkill(ROOT, {
  action: "create",
  name: "agent-owned",
  content: "---\nname: agent-owned\ndescription: Agent skill.\n---\n\n# Agent Owned\n\nBody.\n",
});
const ap = await applySkillOperations(
  ROOT,
  [{ action: "patch", name: "agent-owned", old_string: "Body.", new_string: "Body v2." }],
  { origin: "agent" },
);
assert("review may patch agent-created skill", ap.applied === 1, JSON.stringify(ap));

await fs.rm(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
