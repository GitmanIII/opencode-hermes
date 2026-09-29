/**
 * opencode-hermes — paths (Hermes core).
 *
 * Hermes' built-in memory is exactly two files under the data root:
 *   MEMORY.md   agent notes
 *   USER.md     user profile
 * Override the root with HERMES_OPENCODE_MEMORY_ROOT.
 *
 * Skills live under a separate root (HERMES_OPENCODE_SKILLS_ROOT).
 */
import * as os from "node:os";
import * as path from "node:path";

export let MEMORY_ROOT =
  process.env.HERMES_OPENCODE_MEMORY_ROOT ?? path.join(os.homedir(), ".config", "opencode", "memories");

export function setMemoryRoot(root: string): void {
  MEMORY_ROOT = root;
}
export function memoryRoot(): string {
  return MEMORY_ROOT;
}

export function memoryFile(): string {
  return path.join(MEMORY_ROOT, "MEMORY.md");
}
export function userFile(): string {
  return path.join(MEMORY_ROOT, "USER.md");
}

/**
 * Skills root (procedural memory). Defaults to ~/.agents/skills, which opencode
 * already auto-scans and indexes.
 */
export let SKILLS_ROOT =
  process.env.HERMES_OPENCODE_SKILLS_ROOT ?? path.join(os.homedir(), ".agents", "skills");

export function setSkillsRoot(root: string): void {
  SKILLS_ROOT = root;
}
export function skillsRoot(): string {
  return SKILLS_ROOT;
}
