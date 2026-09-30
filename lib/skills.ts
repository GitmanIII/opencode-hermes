/**
 * opencode-hermes — skills subsystem (procedural memory).
 *
 * Hermes treats skills as procedural memory: SKILL.md directories with
 * progressive-disclosure support files, a skill_manage tool, and usage /
 * provenance tracking. opencode already discovers and indexes SKILL.md files,
 * so this module focuses on safe authoring + management + telemetry over a
 * skills root; opencode handles the prompt-side index.
 *
 * Dependency-free frontmatter handling (line-based), mirroring the Hermes
 * validator's hard requirements: leading `---`, closing `---`, a `name`, a
 * `description`, and a non-empty body.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_CONTENT_CHARS = 100_000;
export const MAX_SKILL_FILE_BYTES = 1_048_576;
export const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const SUPPORT_DIRS = ["references", "templates", "scripts", "assets"] as const;
const EXCLUDED_DIRS = new Set([
  ".git",
  ".github",
  ".hub",
  ".archive",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ...SUPPORT_DIRS,
]);

export type SkillAction = "create" | "patch" | "edit" | "delete" | "write_file" | "remove_file";

export type SkillRecord = {
  name: string;
  description: string;
  category: string | null;
  dir: string;
  path: string;
  version?: string;
};

export type SkillFrontmatter = {
  name: string;
  description: string;
  version?: string;
  body: string;
};

export type ManageParams = {
  action: SkillAction;
  name: string;
  category?: string;
  content?: string;
  filePath?: string;
  fileContent?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
};

export type ManageResult = {
  success: boolean;
  error?: string;
  path?: string;
  name?: string;
  change?: string;
  availableFiles?: string[];
};

const DEFAULT_USAGE = ".usage.json";

// ─── Frontmatter ───

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function parseFrontmatter(content: string): { fm?: SkillFrontmatter; error?: string } {
  const text = content.replace(/^\uFEFF/, "");
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { error: "SKILL.md must start with a `---` frontmatter block closed by `---`." };
  const raw = m[1];
  const body = m[2];
  const name = raw.match(/^name:\s*(.+)$/m)?.[1];
  const description = raw.match(/^description:\s*(.+)$/m)?.[1];
  const version = raw.match(/^version:\s*(.+)$/m)?.[1];
  if (!name) return { error: "frontmatter is missing `name`." };
  if (!description) return { error: "frontmatter is missing `description`." };
  const cleanName = unquote(name);
  const cleanDescription = unquote(description);
  if (!VALID_NAME_RE.test(cleanName)) return { error: `invalid name '${cleanName}': use lowercase [a-z0-9._-], start alphanumeric.` };
  if (cleanName.length > MAX_NAME_LENGTH) return { error: `name exceeds ${MAX_NAME_LENGTH} chars.` };
  if (cleanDescription.length > MAX_DESCRIPTION_LENGTH) return { error: `description exceeds ${MAX_DESCRIPTION_LENGTH} chars.` };
  if (!body.trim()) return { error: "SKILL.md has an empty body." };
  return { fm: { name: cleanName, description: cleanDescription, version: version ? unquote(version) : undefined, body } };
}

// ─── Discovery ───

async function walkSkillFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (EXCLUDED_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const skillMd = path.join(full, "SKILL.md");
    try {
      await fs.access(skillMd);
      out.push(skillMd);
      continue; // don't descend into a skill's own support dirs
    } catch {
      /* not a skill dir; keep walking (category folders) */
    }
    await walkSkillFiles(full, root, out);
  }
}

export async function listSkills(root: string): Promise<SkillRecord[]> {
  const found: string[] = [];
  await walkSkillFiles(root, root, found);
  const records: SkillRecord[] = [];
  for (const file of found) {
    try {
      const content = (await fs.readFile(file, "utf-8")).slice(0, 4000);
      const { fm } = parseFrontmatter(content);
      if (!fm) continue;
      const rel = path.relative(root, path.dirname(file));
      const parts = rel.split(path.sep);
      const category = parts.length > 1 ? parts[0] : null;
      records.push({ name: fm.name, description: fm.description, category, dir: path.dirname(file), path: file, version: fm.version });
    } catch {
      /* skip unreadable */
    }
  }
  records.sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name));
  return records;
}

/** Resolve a skill directory by folder name or frontmatter name. */
export async function resolveSkillDir(root: string, name: string): Promise<{ dir?: string; error?: string }> {
  if (!VALID_NAME_RE.test(name)) return { error: `invalid skill name '${name}'.` };
  const skills = await listSkills(root);
  const byDir = skills.filter((s) => path.basename(s.dir) === name);
  const byName = skills.filter((s) => s.name === name);
  const matches = byDir.length ? byDir : byName;
  if (matches.length === 0) return { error: `no skill named '${name}'.` };
  if (matches.length > 1) return { error: `ambiguous skill name '${name}': ${matches.map((m) => m.path).join(", ")}` };
  return { dir: matches[0].dir };
}

export async function viewSkill(
  root: string,
  name: string,
  filePath?: string,
): Promise<{ success: boolean; error?: string; name?: string; content?: string; path?: string; linkedFiles?: string[]; availableFiles?: string[] }> {
  const { dir, error } = await resolveSkillDir(root, name);
  if (!dir) return { success: false, error };
  if (filePath) {
    const target = path.resolve(dir, filePath);
    if (!isInside(dir, target)) return { success: false, error: "file_path escapes the skill directory." };
    try {
      const content = await fs.readFile(target, "utf-8");
      return { success: true, name, content, path: target };
    } catch {
      return { success: false, error: `file not found: ${filePath}`, availableFiles: await linkedFiles(dir) };
    }
  }
  const content = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8");
  return { success: true, name, content, path: path.join(dir, "SKILL.md"), linkedFiles: await linkedFiles(dir) };
}

async function linkedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of SUPPORT_DIRS) {
    const d = path.join(dir, sub);
    try {
      for (const f of await fs.readdir(d)) out.push(`${sub}/${f}`);
    } catch {
      /* none */
    }
  }
  return out;
}

// ─── Guards ───

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ─── Usage / provenance sidecar ───

export type UsageRecord = {
  created_by?: string;
  use_count?: number;
  view_count?: number;
  patch_count?: number;
  last_used_at?: string;
  last_viewed_at?: string;
  last_patched_at?: string;
  created_at?: string;
  state?: "active" | "stale" | "archived";
  pinned?: boolean;
  archived_at?: string;
};

export async function readUsage(root: string): Promise<Record<string, UsageRecord>> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, DEFAULT_USAGE), "utf-8"));
  } catch {
    return {};
  }
}

async function writeUsage(root: string, usage: Record<string, UsageRecord>): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, DEFAULT_USAGE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(usage, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

export async function bumpUsage(root: string, name: string, field: "use" | "view" | "patch", createdBy?: string): Promise<void> {
  const usage = await readUsage(root);
  const rec = usage[name] ?? {};
  if (createdBy && !rec.created_by) rec.created_by = createdBy;
  rec.created_at = rec.created_at ?? new Date().toISOString();
  if (field === "use") {
    rec.use_count = (rec.use_count ?? 0) + 1;
    rec.last_used_at = new Date().toISOString();
  } else if (field === "view") {
    rec.view_count = (rec.view_count ?? 0) + 1;
    rec.last_viewed_at = new Date().toISOString();
  } else {
    rec.patch_count = (rec.patch_count ?? 0) + 1;
    rec.last_patched_at = new Date().toISOString();
  }
  usage[name] = rec;
  await writeUsage(root, usage);
}

export async function provenance(root: string, name: string): Promise<string> {
  const usage = await readUsage(root);
  return usage[name]?.created_by ?? "unknown";
}

export async function setPinned(root: string, name: string, pinned: boolean): Promise<void> {
  const usage = await readUsage(root);
  const rec = usage[name] ?? {};
  rec.pinned = pinned;
  usage[name] = rec;
  await writeUsage(root, usage);
}

export type CurateOptions = {
  staleAfterDays?: number;
  archiveAfterDays?: number;
  dryRun?: boolean;
  now?: number;
};

export type CurateResult = {
  stale: string[];
  archived: string[];
  skipped: string[];
  dryRun: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_DIR = ".archive";

function latestActivity(rec: UsageRecord): number | null {
  const stamps = [rec.last_used_at, rec.last_viewed_at, rec.last_patched_at, rec.created_at]
    .filter((s): s is string => typeof s === "string")
    .map((s) => Date.parse(s))
    .filter((n) => !Number.isNaN(n));
  return stamps.length ? Math.max(...stamps) : null;
}

/**
 * Lifecycle curation for AGENT-created skills only. User/hand-authored skills
 * (no `created_by: agent`) and pinned skills are never touched. Inactive skills
 * are marked `stale` after staleAfterDays and moved to `<root>/.archive/` after
 * archiveAfterDays. Restorable via restoreSkill.
 */
export async function curateSkills(root: string, opts: CurateOptions = {}): Promise<CurateResult> {
  const staleAfterDays = opts.staleAfterDays ?? 30;
  const archiveAfterDays = opts.archiveAfterDays ?? 90;
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;

  const usage = await readUsage(root);
  const skills = await listSkills(root);
  const result: CurateResult = { stale: [], archived: [], skipped: [], dryRun };

  for (const skill of skills) {
    const rec = usage[skill.name];
    if (!rec || rec.created_by !== "agent" || rec.pinned) {
      result.skipped.push(skill.name);
      continue;
    }
    const activity = latestActivity(rec);
    if (activity === null) {
      result.skipped.push(skill.name);
      continue;
    }
    const ageDays = (now - activity) / DAY_MS;
    if (ageDays >= archiveAfterDays) {
      if (!dryRun) {
        const dest = await uniqueArchivePath(root, skill.name);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(skill.dir, dest);
        rec.state = "archived";
        rec.archived_at = new Date(now).toISOString();
        usage[skill.name] = rec;
      }
      result.archived.push(skill.name);
    } else if (ageDays >= staleAfterDays) {
      if (!dryRun) {
        rec.state = "stale";
        usage[skill.name] = rec;
      }
      result.stale.push(skill.name);
    } else if (rec.state && rec.state !== "active") {
      if (!dryRun) {
        rec.state = "active";
        usage[skill.name] = rec;
      }
    }
  }

  if (!dryRun) await writeUsage(root, usage);
  return result;
}

async function uniqueArchivePath(root: string, name: string): Promise<string> {
  const base = path.join(root, ARCHIVE_DIR, name);
  let candidate = base;
  let i = 1;
  while (await pathExists(candidate)) candidate = `${base}-${i++}`;
  return candidate;
}

export async function restoreSkill(root: string, name: string): Promise<{ success: boolean; error?: string }> {
  if (!VALID_NAME_RE.test(name)) return { success: false, error: `invalid skill name '${name}'.` };
  const archive = path.join(root, ARCHIVE_DIR);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(archive);
  } catch {
    return { success: false, error: "no archived skills." };
  }
  const match = entries.find((e) => e === name || e.startsWith(`${name}-`));
  if (!match) return { success: false, error: `no archived skill named '${name}'.` };
  const src = path.join(archive, match);
  const dest = path.join(root, name);
  if (await pathExists(dest)) return { success: false, error: `a skill named '${name}' already exists.` };
  await fs.rename(src, dest);
  const usage = await readUsage(root);
  const rec = usage[name] ?? {};
  rec.state = "active";
  delete rec.archived_at;
  usage[name] = rec;
  await writeUsage(root, usage);
  return { success: true };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── Manage ───

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function manageSkill(root: string, params: ManageParams): Promise<ManageResult> {
  const { action, name } = params;
  if (!VALID_NAME_RE.test(name ?? "")) return { success: false, error: `invalid skill name '${name}'.` };

  if (action === "create") {
    if (!params.content) return { success: false, error: "create requires content." };
    if (params.content.length > MAX_SKILL_CONTENT_CHARS) return { success: false, error: `SKILL.md exceeds ${MAX_SKILL_CONTENT_CHARS} chars.` };
    const { fm, error } = parseFrontmatter(params.content);
    if (!fm) return { success: false, error };
    if (fm.name !== name) return { success: false, error: `frontmatter name '${fm.name}' must match '${name}'.` };
    if (params.category && !VALID_NAME_RE.test(params.category)) return { success: false, error: `invalid category '${params.category}'.` };
    const existing = await resolveSkillDir(root, name);
    if (existing.dir) return { success: false, error: `skill '${name}' already exists at ${existing.dir}.` };
    const dir = params.category ? path.join(root, params.category, name) : path.join(root, name);
    if (!isInside(root, dir)) return { success: false, error: "skill path escapes the skills root." };
    if (await pathExists(dir)) return { success: false, error: `skill directory already exists at ${dir}.` };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), params.content, "utf-8");
    await bumpUsage(root, name, "patch", "agent");
    return { success: true, name, path: path.join(dir, "SKILL.md") };
  }

  const { dir, error } = await resolveSkillDir(root, name);
  if (!dir) return { success: false, error };

  if (action === "edit") {
    if (!params.content) return { success: false, error: "edit requires content." };
    if (params.content.length > MAX_SKILL_CONTENT_CHARS) return { success: false, error: `SKILL.md exceeds ${MAX_SKILL_CONTENT_CHARS} chars.` };
    const { fm, error: ferr } = parseFrontmatter(params.content);
    if (!fm) return { success: false, error: ferr };
    if (fm.name !== name) return { success: false, error: `frontmatter name '${fm.name}' must match '${name}'.` };
    await fs.writeFile(path.join(dir, "SKILL.md"), params.content, "utf-8");
    await bumpUsage(root, name, "patch");
    return { success: true, name, path: path.join(dir, "SKILL.md") };
  }

  if (action === "patch") {
    if (params.oldString === undefined || params.newString === undefined) return { success: false, error: "patch requires old_string and new_string." };
    if (params.oldString === "") return { success: false, error: "patch requires a non-empty old_string." };
    const target = params.filePath ? path.resolve(dir, params.filePath) : path.join(dir, "SKILL.md");
    if (!isInside(dir, target)) return { success: false, error: "file_path escapes the skill directory." };
    let content: string;
    try {
      content = await fs.readFile(target, "utf-8");
    } catch {
      return { success: false, error: `file not found: ${params.filePath ?? "SKILL.md"}`, availableFiles: await linkedFiles(dir) };
    }
    let updated: string | null = null;
    if (content.includes(params.oldString)) {
      // Replacement via a function so `$&`/`$$` in new_string stay literal.
      updated = params.replaceAll
        ? content.split(params.oldString).join(params.newString)
        : content.replace(params.oldString, () => params.newString!);
    } else {
      // normalized-whitespace fallback for a single occurrence
      const idx = normalize(content).indexOf(normalize(params.oldString));
      if (idx >= 0) {
        const re = new RegExp(params.oldString.trim().split(/\s+/).map(escapeRe).join("\\s+"));
        updated = content.replace(re, () => params.newString!);
      }
    }
    if (updated === null || updated === content) return { success: false, error: "old_string not found (or no change)." };
    if (target.endsWith("SKILL.md")) {
      const { fm, error: ferr } = parseFrontmatter(updated);
      if (!fm) return { success: false, error: `patch would invalidate frontmatter: ${ferr}` };
    }
    await fs.writeFile(target, updated, "utf-8");
    await bumpUsage(root, name, "patch");
    return { success: true, name, path: target, change: "patched" };
  }

  if (action === "write_file") {
    if (!params.filePath || params.fileContent === undefined) return { success: false, error: "write_file requires file_path and file_content." };
    const target = path.resolve(dir, params.filePath);
    if (!isInside(dir, target)) return { success: false, error: "file_path escapes the skill directory." };
    const sub = path.relative(dir, target).split(path.sep)[0];
    if (!(SUPPORT_DIRS as readonly string[]).includes(sub)) return { success: false, error: `support files must live under: ${SUPPORT_DIRS.join(", ")}.` };
    if (Buffer.byteLength(params.fileContent, "utf-8") > MAX_SKILL_FILE_BYTES) return { success: false, error: `file exceeds ${MAX_SKILL_FILE_BYTES} bytes.` };
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, params.fileContent, "utf-8");
    await bumpUsage(root, name, "patch");
    return { success: true, name, path: target, change: "wrote file" };
  }

  if (action === "remove_file") {
    if (!params.filePath) return { success: false, error: "remove_file requires file_path." };
    const target = path.resolve(dir, params.filePath);
    if (!isInside(dir, target)) return { success: false, error: "file_path escapes the skill directory." };
    try {
      await fs.rm(target, { force: true });
    } catch {
      return { success: false, error: `could not remove ${params.filePath}`, availableFiles: await linkedFiles(dir) };
    }
    await bumpUsage(root, name, "patch");
    return { success: true, name, path: target, change: "removed file" };
  }

  if (action === "delete") {
    const resolved = path.resolve(dir);
    if (resolved === path.resolve(root) || !isInside(root, resolved)) return { success: false, error: "refusing to delete outside the skills root." };
    await fs.rm(resolved, { recursive: true, force: true });
    return { success: true, name, change: "deleted" };
  }

  return { success: false, error: `unknown action '${action}'.` };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── LLM-driven skill operations (from the self-learning review) ───

export type SkillOperation = {
  action: SkillAction;
  name?: string;
  category?: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  file_path?: string;
  file_content?: string;
  replace_all?: boolean;
};

export async function applySkillOperations(
  root: string,
  ops: SkillOperation[],
  opts: { origin?: "agent" | "foreground" } = {},
): Promise<{ errors: string[]; applied: number }> {
  const errors: string[] = [];
  let applied = 0;
  for (const op of ops) {
    if (!op || typeof op.action !== "string") {
      errors.push("skill operation missing action");
      continue;
    }
    if (!op.name) {
      errors.push(`skill ${op.action}: missing name`);
      continue;
    }
    // Guard: the autonomous review (origin "agent") may only create new skills
    // or modify skills it created itself. User/hand-authored skills are
    // protected from background edits/deletes.
    if (opts.origin === "agent" && op.action !== "create") {
      const owner = await provenance(root, op.name);
      if (owner !== "agent") {
        errors.push(`skill ${op.action} '${op.name}': protected (not agent-created; use the skill_manage tool explicitly)`);
        continue;
      }
    }
    const r = await manageSkill(root, {
      action: op.action,
      name: op.name,
      category: op.category,
      content: op.content,
      filePath: op.file_path,
      fileContent: op.file_content,
      oldString: op.old_string,
      newString: op.new_string,
      replaceAll: op.replace_all,
    });
    if (r.success) applied++;
    else errors.push(`skill ${op.action} '${op.name}': ${r.error}`);
  }
  return { errors, applied };
}
