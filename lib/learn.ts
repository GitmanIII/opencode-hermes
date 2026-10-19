/**
 * opencode-hermes — learning loop (Hermes core).
 *
 * Background review on session idle: build a transcript, ask the model for
 * memory + skill operations, apply them. Flush review before compaction.
 * No correction detection, no consolidation (Hermes core).
 */
import type { ReviewChannel, TranscriptMessage } from "./channel.ts";
import { isInternalSession } from "./llm.ts";
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
      // Only strip trailing commas: the model is told to emit bare JSON, and a
      // blanket `//`/`/* */` strip would corrupt `//` inside a string value
      // (e.g. a URL in a memory entry).
      const repaired = cleaned.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
      const out = parse(repaired);
      if (out.operations.length > 0 || out.skills.length > 0) return out;
    } catch {
      /* ignore */
    }
    return { operations: [], skills: [], error: `Failed to parse operations JSON: ${String(err)}` };
  }
}

/** Apply memory operations grouped by target (each target is an atomic batch). */
export type ApplyOperationsResult = {
  errors: string[];
  applied: number;
  /** Per-target applied counts; a batch is atomic per target. */
  appliedByTarget: Record<Target, number>;
  /** Per-target errors, already prefixed with the target name. */
  errorsByTarget: Record<Target, string[]>;
};

function emptyApplyResult(): ApplyOperationsResult {
  return {
    errors: [],
    applied: 0,
    appliedByTarget: { memory: 0, user: 0 },
    errorsByTarget: { memory: [], user: [] },
  };
}

export async function applyOperations(
  store: MemoryStore,
  operations: MemoryOperation[],
  manager?: MemoryManager | null,
): Promise<ApplyOperationsResult> {
  const result = emptyApplyResult();
  const byTarget = new Map<Target, MemoryOperation[]>();
  for (const op of operations) {
    const t = ((op as { target?: Target }).target ?? "memory") as Target;
    if (t !== "memory" && t !== "user") {
      result.errors.push(`memory operation ignored: invalid target '${String((op as { target?: unknown }).target)}'`);
      continue;
    }
    if (!byTarget.has(t)) byTarget.set(t, []);
    byTarget.get(t)!.push(op);
  }
  for (const [target, ops] of byTarget) {
    const applied = await store.applyBatch(target, ops);
    if (!applied.success) {
      const error = `${target}: ${applied.error}`;
      result.errors.push(error);
      result.errorsByTarget[target].push(error);
    } else {
      const count = applied.resolved?.length ?? ops.length;
      result.applied += count;
      result.appliedByTarget[target] += count;
      if (manager) await manager.mirrorResolved(applied.resolved);
    }
  }
  return result;
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

// ─── Shared review pipeline (background + pre-compaction flush) ───

const BUDGET_ERROR = /exceed the limit/i;

/**
 * State the budget explicitly. The interactive `memory` tool documents the
 * "reissue as ONE batch that demotes/shortens AND adds together" flow, but the
 * review is a plain completion that never sees the tool description — so a full
 * store silently swallowed every new fact (observed: reviews logged "produced no
 * applicable operations" indefinitely while MEMORY.md sat at 98%).
 */
function budgetSection(store: MemoryStore): string {
  return (
    "<memory-budget>\n" +
    `${store.usage("memory")}\n` +
    `${store.usage("user")}\n` +
    "An 'add' whose final result exceeds a target's limit is rejected outright. If a target is near or over its limit, " +
    "include demotes or shortenings of the least valuable stale entries in the SAME 'operations' batch as the new fact " +
    "('demote' frees room but keeps the fact recallable in long-term memory; 'remove' is only for wrong or superseded facts). " +
    "Never omit a fact merely because the store is full.\n" +
    "</memory-budget>\n\n"
  );
}

/** Entries with per-entry sizes, so the consolidation retry can name what to free. */
function entriesSection(store: MemoryStore): string {
  const lines: string[] = [];
  for (const target of ["memory", "user"] as const) {
    const entries = store.getEntries(target);
    if (!entries.length) continue;
    lines.push(`${target} (${store.chars(target)}/${store.charLimit(target)} chars):`);
    for (const entry of entries) lines.push(`  - [${entry.length} chars] ${entry}`);
  }
  return `<entries>\n${lines.join("\n")}\n</entries>\n\n`;
}

function targetOf(op: MemoryOperation): Target | undefined {
  const target = (op as { target?: unknown }).target;
  if (target === undefined) return "memory";
  return target === "memory" || target === "user" ? target : undefined;
}

function consolidateInstruction(blocked: Target[]): string {
  const which = blocked.length === 1 ? "that target" : "those targets";
  return (
    `The previous batch could not write to: ${blocked.join(", ")} because it would exceed the char limit. ` +
    `Reissue ONE batch for ${which} only, demoting or shortening enough low-priority entries to make room AND including ` +
    `your new fact(s) — the limit is checked only on the final result. Use the size shown for each entry to choose what to free.`
  );
}

export type ExtractedOperations = { operations: MemoryOperation[]; skills: SkillOperation[]; error?: string };

/**
 * Apply a parsed operation set. If a target's batch was blocked by the char
 * budget, retry once for those targets only. Skills are applied once and never
 * re-applied: a skill write (or its error) must not suppress the memory retry,
 * and a retry must not duplicate skill work.
 */
async function applyReviewOperations(opts: {
  channel: ReviewChannel;
  store: MemoryStore;
  systemPrompt: string;
  userPrompt: string;
  sessionID: string;
  parsed: ExtractedOperations;
  skillsRoot?: string;
  manager?: MemoryManager | null;
}): Promise<{ applied: number; appliedSkills: number; errors: string[] }> {
  const memory = opts.parsed.operations.length
    ? await applyOperations(opts.store, opts.parsed.operations, opts.manager)
    : emptyApplyResult();
  const skillOps = opts.skillsRoot ? opts.parsed.skills : [];
  const skills = skillOps.length
    ? await applySkillOperations(opts.skillsRoot!, skillOps, { origin: "agent" })
    : { errors: [] as string[], applied: 0 };
  const firstErrors = [...memory.errors, ...skills.errors];

  const blockedTargets = (["memory", "user"] as const).filter(
    (target) =>
      memory.appliedByTarget[target] === 0 &&
      memory.errorsByTarget[target].some((error) => BUDGET_ERROR.test(error)),
  );
  if (!blockedTargets.length) {
    return { applied: memory.applied, appliedSkills: skills.applied, errors: firstErrors };
  }

  const userPrompt =
    `${opts.userPrompt}\n\n${entriesSection(opts.store)}${consolidateInstruction(blockedTargets)}\n` +
    "Respond with the operations JSON only.";
  const completion = await opts.channel.complete(opts.systemPrompt, userPrompt, opts.sessionID);
  if (completion.error || !completion.text) {
    return {
      applied: memory.applied,
      appliedSkills: skills.applied,
      errors: [...firstErrors, completion.error || "consolidation retry returned no text"],
    };
  }
  const next = extractOperations(completion.text);
  if (next.error) {
    return { applied: memory.applied, appliedSkills: skills.applied, errors: [...firstErrors, next.error] };
  }

  // Apply only the blocked targets. A successful target from the first batch is
  // not re-applied, and skills are not repeated.
  const retryOps = next.operations.filter((op) => {
    const target = targetOf(op);
    return target !== undefined && blockedTargets.includes(target);
  });
  if (!retryOps.length) {
    return {
      applied: memory.applied,
      appliedSkills: skills.applied,
      errors: [...firstErrors, `consolidation retry produced no operations for: ${blockedTargets.join(", ")}`],
    };
  }

  const retry = await applyOperations(opts.store, retryOps, opts.manager);
  const errors = [...skills.errors];
  for (const target of ["memory", "user"] as const) {
    errors.push(...(blockedTargets.includes(target) ? retry.errorsByTarget[target] : memory.errorsByTarget[target]));
  }
  // Preserve errors not attached to a target (invalid-target operations).
  errors.push(...memory.errors.filter((error) => !/^(memory|user):/.test(error)));
  return {
    applied: memory.applied + retry.applied,
    appliedSkills: skills.applied,
    errors,
  };
}

/** Build the review user prompt: transcript, existing memory/skills, budget. */
async function reviewPrompt(opts: { intro: string; transcript: string; projectId: string; store: MemoryStore; skillsRoot?: string }): Promise<string> {
  const skillsSection = opts.skillsRoot ? await existingSkillsSection(opts.skillsRoot) : "";
  return (
    `${opts.intro}\n\n<conversation>\n${opts.transcript}\n</conversation>\n\n` +
    `${existingMemorySection(opts.store)}${skillsSection}${budgetSection(opts.store)}` +
    `Active project: ${opts.projectId || "(none)"}\nRespond with the operations JSON only.`
  );
}

export async function runBackgroundReview(
  channel: ReviewChannel,
  store: MemoryStore,
  projectId: string,
  sessionID: string,
  skillsRoot?: string,
  manager?: MemoryManager | null,
): Promise<{ savedCount: number; savedSkills?: number; error?: string }> {
  try {
    const all = await channel.transcript(sessionID);
    let lastCount = reviewedUpTo.get(sessionID) ?? 0;
    if (lastCount > all.length) lastCount = 0;
    const transcript = buildTranscript(all.slice(lastCount));
    if (!transcript.trim()) return { savedCount: 0 };

    const userPrompt = await reviewPrompt({ intro: REVIEW_USER_PROMPT, transcript, projectId, store, skillsRoot });
    const completion = await channel.complete(DIRECT_REVIEW_SYSTEM_PROMPT, userPrompt, sessionID);
    if (completion.error || !completion.text) return { savedCount: 0, error: completion.error || "empty model output" };

    const parsed = extractOperations(completion.text);
    if (parsed.error) return { savedCount: 0, error: parsed.error };
    reviewedUpTo.set(sessionID, all.length);

    const applied = await applyReviewOperations({ channel, store, systemPrompt: DIRECT_REVIEW_SYSTEM_PROMPT, userPrompt, sessionID, parsed, skillsRoot, manager });
    if (!applied.applied && !applied.appliedSkills) debug(`review for session ${sessionID} produced no applicable operations`);
    return {
      savedCount: applied.applied + applied.appliedSkills,
      savedSkills: applied.appliedSkills,
      error: applied.errors.join("; ") || undefined,
    };
  } catch (err) {
    return { savedCount: 0, error: String(err) };
  }
}

export async function runFlushReview(
  channel: ReviewChannel,
  store: MemoryStore,
  projectId: string,
  sessionID: string,
  skillsRoot?: string,
  manager?: MemoryManager | null,
): Promise<{ savedCount: number; savedSkills?: number; error?: string }> {
  try {
    const all = await channel.transcript(sessionID);
    const transcript = buildTranscript(all.slice(-20));
    if (!transcript.trim()) return { savedCount: 0 };

    const intro = `Session ${sessionID} (project: ${projectId || "(none)"}) is being compressed.`;
    const userPrompt = await reviewPrompt({ intro, transcript, projectId, store, skillsRoot });
    const completion = await channel.complete(DIRECT_FLUSH_SYSTEM_PROMPT, userPrompt, sessionID);
    if (completion.error || !completion.text) return { savedCount: 0, error: completion.error || "empty model output" };

    const parsed = extractOperations(completion.text);
    if (parsed.error) return { savedCount: 0, error: parsed.error };

    const applied = await applyReviewOperations({ channel, store, systemPrompt: DIRECT_FLUSH_SYSTEM_PROMPT, userPrompt, sessionID, parsed, skillsRoot, manager });
    return {
      savedCount: applied.applied + applied.appliedSkills,
      savedSkills: applied.appliedSkills,
      error: applied.errors.join("; ") || undefined,
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
  channel: ReviewChannel,
  store: MemoryStore,
  manager?: MemoryManager | null,
  useJudge = false,
  sessionID?: string,
): Promise<ReconcileStats | undefined> {
  if (!manager?.provider?.reconcile) return undefined;
  const canonical = [...store.getEntries("memory"), ...store.getEntries("user")].filter(Boolean);
  if (!canonical.length) return undefined;
  const judge = useJudge
    ? async (canonicalText: string, noteText: string) => {
        const out = await channel.complete(
          DREAM_JUDGE_SYSTEM_PROMPT,
          `CURRENT FACT:\n${canonicalText}\n\nOLDER NOTE:\n${noteText}\n\nAnswer with one word: YES or NO.`,
          sessionID,
        );
        return /^\s*yes/i.test(out.text ?? "");
      }
    : undefined;
  // The dream runs on idle; hardDelete GCs the tombstones it created so the
  // store doesn't grow without bound (tombstones are invisible to recall and
  // re-adding a superseded fact already inserts a fresh live note).
  return manager.reconcile(canonical, { judge, hardDelete: true });
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

const TRANSCRIPT_MAX_CHARS = 30_000;

function buildTranscript(messages: TranscriptMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.summary) continue;
    const text = msg.text.trim();
    if (!text) continue;
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (msg.role === "assistant" && msg.modelID) {
      lines.push(`<assistant model="${msg.modelID}">\n${text}\n</assistant>`);
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
