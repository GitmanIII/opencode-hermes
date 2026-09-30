/**
 * opencode-hermes — learning loop (Hermes core).
 *
 * Background review on session idle: build a transcript, ask the model for
 * memory + skill operations, apply them. Flush review before compaction.
 * No correction detection, no consolidation (Hermes core).
 */
import type { PluginInput } from "@opencode-ai/plugin";
import { completeWithInternalSession, isInternalSession } from "./llm.ts";
import {
  DIRECT_FLUSH_SYSTEM_PROMPT,
  DIRECT_REVIEW_SYSTEM_PROMPT,
  DREAM_JUDGE_SYSTEM_PROMPT,
  REVIEW_USER_PROMPT,
} from "./prompts.ts";
import { applySkillOperations, listSkills, type SkillOperation } from "./skills.ts";
import type { MemoryManager } from "./memory-manager.ts";
import type { ReconcileStats } from "./memory-provider.ts";
import type { MemoryOperation, MemoryStore, Target } from "./store.ts";

// ─── Operations extraction from LLM JSON output ───

type RawOperation = { action?: unknown; [key: string]: unknown };
type RawParsed = { operations?: unknown; skills?: unknown };

function opsFromParsed(parsed: unknown): MemoryOperation[] {
  const rawOps = Array.isArray(parsed) ? parsed : (parsed as RawParsed | null)?.operations;
  const ops = Array.isArray(rawOps) ? rawOps : [];
  return ops.filter((op): op is MemoryOperation => {
    if (!op || typeof op !== "object") return false;
    const action = (op as RawOperation).action;
    return action === "add" || action === "replace" || action === "remove" || action === "demote";
  });
}

function skillsFromParsed(parsed: unknown): SkillOperation[] {
  const raw = (parsed as RawParsed | null)?.skills;
  const ops = Array.isArray(raw) ? raw : [];
  return ops.filter((op): op is SkillOperation => {
    if (!op || typeof op !== "object") return false;
    return typeof (op as RawOperation).action === "string" && (op as RawOperation).action !== "";
  });
}

export function extractOperations(text: string): {
  operations: MemoryOperation[];
  skills: SkillOperation[];
  error?: string;
} {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const parse = (s: string) => {
    const parsed = JSON.parse(s);
    return { operations: opsFromParsed(parsed), skills: skillsFromParsed(parsed) };
  };
  try {
    return parse(cleaned);
  } catch {
    /* fall through to brace-slice */
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return { operations: [], skills: [], error: "No JSON object found in model output." };
  try {
    return parse(cleaned.slice(start, end + 1));
  } catch (err) {
    try {
      const repaired = cleaned
        .slice(start, end + 1)
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const out = parse(repaired);
      if (out.operations.length > 0 || out.skills.length > 0) return out;
    } catch {
      /* ignore */
    }
    return { operations: [], skills: [], error: `Failed to parse operations JSON: ${String(err)}` };
  }
}

/** Apply memory operations grouped by target (each target is an atomic batch). */
export async function applyOperations(
  store: MemoryStore,
  operations: MemoryOperation[],
  manager?: MemoryManager | null,
): Promise<{ errors: string[]; applied: number }> {
  const errors: string[] = [];
  let applied = 0;
  const byTarget = new Map<Target, MemoryOperation[]>();
  for (const op of operations) {
    const t = ((op as { target?: Target }).target ?? "memory") as Target;
    if (t !== "memory" && t !== "user") {
      errors.push(`memory operation ignored: invalid target '${String((op as { target?: unknown }).target)}'`);
      continue;
    }
    if (!byTarget.has(t)) byTarget.set(t, []);
    byTarget.get(t)!.push(op);
  }
  for (const [target, ops] of byTarget) {
    const result = await store.applyBatch(target, ops);
    if (!result.success) errors.push(`${target}: ${result.error}`);
    else {
      applied += result.resolved?.length ?? ops.length;
      if (manager) await manager.mirrorResolved(result.resolved);
    }
  }
  return { errors, applied };
}

// ─── Background review (session.idle) ───

const reviewedUpTo = new Map<string, number>();

/** List existing memory so the review model avoids duplicates. */
function existingMemorySection(store: MemoryStore): string {
  const lines = [...store.getEntries("memory"), ...store.getEntries("user")].filter(Boolean);
  if (!lines.length) return "";
  let listing = "";
  for (const line of lines) {
    if (listing.length + line.length + 3 > 4000) break;
    listing += `- ${line}\n`;
  }
  return `<existing-memory>\n${listing}</existing-memory>\n\n`;
}

/** List existing skills so the review model prefers patching over creating. */
async function existingSkillsSection(root: string): Promise<string> {
  try {
    const skills = await listSkills(root);
    if (!skills.length) return "";
    let listing = "";
    for (const s of skills) {
      const line = `- ${s.name}: ${s.description}\n`;
      if (listing.length + line.length > 3000) break;
      listing += line;
    }
    return `<existing-skills>\n${listing}</existing-skills>\n\n`;
  } catch {
    return "";
  }
}

export async function runBackgroundReview(
  client: PluginInput["client"],
  store: MemoryStore,
  directory: string,
  projectId: string,
  sessionID: string,
  skillsRoot?: string,
  manager?: MemoryManager | null,
): Promise<{ savedCount: number; savedSkills?: number; error?: string }> {
  try {
    const msgs = await client.session.messages({ path: { id: sessionID } });
    const all = msgs.data ?? [];
    let lastCount = reviewedUpTo.get(sessionID) ?? 0;
    if (lastCount > all.length) lastCount = 0;
    const transcript = buildTranscript(all.slice(lastCount));
    if (!transcript.trim()) return { savedCount: 0 };

    const skillsSection = skillsRoot ? await existingSkillsSection(skillsRoot) : "";
    const userPrompt = `${REVIEW_USER_PROMPT}\n\n<conversation>\n${transcript}\n</conversation>\n\n${existingMemorySection(store)}${skillsSection}Active project: ${projectId || "(none)"}\nRespond with the operations JSON only.`;
    const completion = await completeWithInternalSession(client, directory, DIRECT_REVIEW_SYSTEM_PROMPT, userPrompt);
    if (completion.error || !completion.text) return { savedCount: 0, error: completion.error || "empty model output" };

    const { operations, skills, error } = extractOperations(completion.text);
    if (error) return { savedCount: 0, error };
    reviewedUpTo.set(sessionID, all.length);

    const applied = operations.length ? await applyOperations(store, operations, manager) : { errors: [] as string[], applied: 0 };
    const skillOps = skillsRoot ? skills : [];
    const appliedSkills = skillOps.length
      ? await applySkillOperations(skillsRoot!, skillOps, { origin: "agent" })
      : { errors: [] as string[], applied: 0 };
    const errs = [...applied.errors, ...appliedSkills.errors];
    if (!applied.applied && !appliedSkills.applied) debug(`review for session ${sessionID} produced no applicable operations`);
    return {
      savedCount: applied.applied + appliedSkills.applied,
      savedSkills: appliedSkills.applied,
      error: errs.join("; ") || undefined,
    };
  } catch (err) {
    return { savedCount: 0, error: String(err) };
  }
}

export async function runFlushReview(
  client: PluginInput["client"],
  store: MemoryStore,
  directory: string,
  projectId: string,
  sessionID: string,
  skillsRoot?: string,
  manager?: MemoryManager | null,
): Promise<{ savedCount: number; savedSkills?: number; error?: string }> {
  try {
    const msgs = await client.session.messages({ path: { id: sessionID } });
    const transcript = buildTranscript((msgs.data ?? []).slice(-20));
    if (!transcript.trim()) return { savedCount: 0 };

    const skillsSection = skillsRoot ? await existingSkillsSection(skillsRoot) : "";
    const userPrompt = `Session ${sessionID} (project: ${projectId || "(none)"}) is being compressed.\n\n<conversation>\n${transcript}\n</conversation>\n\n${existingMemorySection(store)}${skillsSection}Respond with the operations JSON only.`;
    const completion = await completeWithInternalSession(client, directory, DIRECT_FLUSH_SYSTEM_PROMPT, userPrompt);
    if (completion.error || !completion.text) return { savedCount: 0, error: completion.error || "empty model output" };

    const { operations, skills, error } = extractOperations(completion.text);
    if (error) return { savedCount: 0, error };
    const applied = operations.length ? await applyOperations(store, operations, manager) : { errors: [] as string[], applied: 0 };
    const skillOps = skillsRoot ? skills : [];
    const appliedSkills = skillOps.length
      ? await applySkillOperations(skillsRoot!, skillOps, { origin: "agent" })
      : { errors: [] as string[], applied: 0 };
    const errs = [...applied.errors, ...appliedSkills.errors];
    return {
      savedCount: applied.applied + appliedSkills.applied,
      savedSkills: appliedSkills.applied,
      error: errs.join("; ") || undefined,
    };
  } catch (err) {
    return { savedCount: 0, error: String(err) };
  }
}

// ─── Dream: reconcile the long-term store against current canonical memory ───

/**
 * Bounded idle reconciliation. The provider compares the current canonical
 * facts (MEMORY.md + USER.md) against its store and supersedes stale/duplicate
 * notes. With `useJudge`, an ambiguous band is resolved by asking the model.
 * Returns undefined when no provider supports `reconcile`.
 */
export async function runDream(
  client: PluginInput["client"],
  store: MemoryStore,
  directory: string,
  manager?: MemoryManager | null,
  useJudge = false,
): Promise<ReconcileStats | undefined> {
  if (!manager?.provider?.reconcile) return undefined;
  const canonical = [...store.getEntries("memory"), ...store.getEntries("user")].filter(Boolean);
  if (!canonical.length) return undefined;
  const judge = useJudge
    ? async (canonicalText: string, noteText: string) => {
        const out = await completeWithInternalSession(
          client,
          directory,
          DREAM_JUDGE_SYSTEM_PROMPT,
          `CURRENT FACT:\n${canonicalText}\n\nOLDER NOTE:\n${noteText}\n\nAnswer with one word: YES or NO.`,
        );
        return /^\s*yes/i.test(out.text ?? "");
      }
    : undefined;
  return manager.reconcile(canonical, { judge });
}

export function clearSession(sessionID: string): void {
  reviewedUpTo.delete(sessionID);
}

export function clearSessionState(): void {
  reviewedUpTo.clear();
}

let debugLogger: ((msg: string) => void) | null = null;
export function setDebugLogger(fn: (msg: string) => void): void {
  debugLogger = fn;
}
function debug(msg: string): void {
  debugLogger?.(msg);
}

// ─── Transcript builder ───

type MessageLike = {
  info: { role?: string; summary?: unknown; modelID?: string };
  parts: Array<{ type: string; text?: string; synthetic?: boolean }>;
};

const TRANSCRIPT_MAX_CHARS = 30_000;

function buildTranscript(messages: MessageLike[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.info.summary) continue;
    const text = (msg.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() && !p.synthetic)
      .map((p) => p.text!.trim())
      .join("\n");
    if (!text) continue;
    const role = msg.info.role === "assistant" ? "assistant" : "user";
    if (msg.info.role === "assistant" && msg.info.modelID) {
      lines.push(`<assistant model="${msg.info.modelID}">\n${text}\n</assistant>`);
    } else {
      lines.push(`<${role}>\n${text}\n</${role}>`);
    }
  }
  // Keep the most recent lines up to the cap, in one pass from the tail
  // (the previous shift-and-rejoin loop was O(n²) and rebuilt the whole string).
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i].length + (kept.length ? 2 : 0);
    if (total + len > TRANSCRIPT_MAX_CHARS && kept.length) break;
    kept.push(lines[i]);
    total += len;
  }
  kept.reverse();
  return kept.join("\n\n");
}

export { isInternalSession };
