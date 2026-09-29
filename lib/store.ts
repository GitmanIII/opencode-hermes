/**
 * opencode-hermes — MemoryStore (Hermes core).
 *
 * Faithful to Hermes' built-in memory (tools/memory_tool.py): two flat,
 * §-delimited files — MEMORY.md (agent notes) and USER.md (user profile) —
 * injected whole into the system prompt, with hard char caps and a single
 * mutation surface (add/replace/remove + atomic batch). No retrieval, no
 * project/failure/history layers, no per-entry metadata.
 *
 * Writes are atomic (temp + rename) with SHA-256 fingerprint conflict
 * detection and retry, so concurrent OpenCode processes don't clobber.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { memoryFile, userFile } from "./paths.ts";
import {
  BLOCK_SEPARATOR,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  ENTRY_DELIMITER,
  MEMORY_BLOCK_HEADERS,
} from "./prompts.ts";

export type Target = "memory" | "user";
export type MemoryAction = "add" | "replace" | "remove";

export type MemoryOperation = {
  action: MemoryAction;
  content?: string;
  old_text?: string;
};

export type MemoryResult = {
  success: boolean;
  error?: string;
  message?: string;
  usage?: string;
  entry_count?: number;
  matches?: string[];
  current_entries?: string[];
  done?: boolean;
};

const MAX_EXTERNAL_WRITE_RETRIES = 2;
const MAX_CONSOLIDATION_FAILURES_PER_TURN = 3;
const TARGETS: Target[] = ["memory", "user"];

class ExternalMemoryWriteConflict extends Error {}

export class MemoryStore {
  private entries: Record<Target, string[]> = { memory: [], user: [] };
  private fingerprints = new Map<string, string>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private consolidationFailures = 0;

  constructor(private opts: { memoryCharLimit?: number; userCharLimit?: number } = {}) {}

  charLimit(target: Target): number {
    return target === "user" ? (this.opts.userCharLimit ?? DEFAULT_USER_CHAR_LIMIT) : (this.opts.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT);
  }

  private pathFor(target: Target): string {
    return target === "user" ? userFile() : memoryFile();
  }

  // ─── Load / read ───

  async loadFromDisk(): Promise<void> {
    await fs.mkdir(path.dirname(memoryFile()), { recursive: true });
    for (const target of TARGETS) {
      const entries = await this.readEntries(target);
      this.entries[target] = [...new Set(entries)];
      this.fingerprints.set(this.pathFor(target), await fingerprint(this.pathFor(target)));
    }
  }

  private async readEntries(target: Target): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.pathFor(target), "utf-8");
      return splitEntries(raw);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private async syncFromDiskIfChanged(target: Target): Promise<void> {
    const file = this.pathFor(target);
    const current = await fingerprint(file);
    if (this.fingerprints.get(file) === current) return;
    this.entries[target] = [...new Set(await this.readEntries(target))];
    this.fingerprints.set(file, current);
  }

  getEntries(target: Target): string[] {
    return [...this.entries[target]];
  }

  entryCount(target: Target): number {
    return this.entries[target].length;
  }

  private charCount(target: Target): number {
    const e = this.entries[target];
    return e.length ? e.join(ENTRY_DELIMITER).length : 0;
  }

  usage(target: Target): string {
    const current = this.charCount(target);
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    return `${target}: ${pct}% — ${current}/${limit} chars (${this.entries[target].length} entries)`;
  }

  /** Hermes-style block for the system prompt (whole file, header + usage). */
  formatBlock(target: Target): string {
    const content = this.entries[target].join(ENTRY_DELIMITER);
    const current = this.charCount(target);
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    const header = `${MEMORY_BLOCK_HEADERS[target]} [${pct}% — ${current}/${limit} chars]`;
    return `${BLOCK_SEPARATOR}\n${header}\n${BLOCK_SEPARATOR}\n${content}`;
  }

  formatForSystemPrompt(): string {
    return TARGETS.map((t) => this.formatBlock(t)).join("\n\n");
  }

  // ─── Failure cap (Hermes: stop a fragile add/replace looping) ───

  resetConsolidationFailures(): void {
    this.consolidationFailures = 0;
  }

  private consolidationFailure(target: Target, prefix: string): MemoryResult {
    this.consolidationFailures++;
    if (this.consolidationFailures > MAX_CONSOLIDATION_FAILURES_PER_TURN) {
      return {
        success: false,
        done: true,
        error: `Memory consolidation failed ${this.consolidationFailures} times this turn. Stop retrying; save other work and try again next turn.`,
        usage: this.usage(target),
      };
    }
    return {
      success: false,
      error: `${prefix} Memory at ${this.charCount(target)}/${this.charLimit(target)} chars. Consolidate now: use 'replace' to shorten or 'remove' entries, then retry — all in this turn.`,
      usage: this.usage(target),
      current_entries: this.entries[target].map((e) => e.slice(0, 80) + (e.length > 80 ? "..." : "")),
    };
  }

  private successResponse(target: Target, message: string): MemoryResult {
    this.consolidationFailures = 0;
    return { success: true, message, usage: this.usage(target), entry_count: this.entries[target].length };
  }

  // ─── Mutations ───

  async add(target: Target, content: string): Promise<MemoryResult> {
    const text = (content ?? "").trim();
    if (!text) return { success: false, error: "add requires content." };
    await this.syncFromDiskIfChanged(target);
    if (this.entries[target].includes(text)) {
      return this.successResponse(target, "Entry already exists (no duplicate added).");
    }
    const next = [...this.entries[target], text];
    if (next.join(ENTRY_DELIMITER).length > this.charLimit(target)) {
      return this.consolidationFailure(target, "Memory is full.");
    }
    await this.saveToDisk(target, next);
    return this.successResponse(target, "Write saved. This update is complete — do not repeat it.");
  }

  async replace(target: Target, oldText: string, content: string): Promise<MemoryResult> {
    const needle = (oldText ?? "").trim();
    const text = (content ?? "").trim();
    if (!needle) return { success: false, error: "replace requires old_text." };
    if (!text) return { success: false, error: "replace requires content." };
    await this.syncFromDiskIfChanged(target);
    const matches = this.entries[target].filter((e) => e.includes(needle));
    if (matches.length === 0) {
      return { success: false, error: `No entry matched '${needle}'.`, current_entries: this.entries[target].map(preview) };
    }
    if (matches.length > 1) {
      return { success: false, error: `Multiple entries matched '${needle}'. Be more specific.`, matches: matches.map(preview) };
    }
    const next = this.entries[target].map((e) => (e === matches[0] ? text : e));
    if (next.join(ENTRY_DELIMITER).length > this.charLimit(target)) {
      return this.consolidationFailure(target, "Replacement would exceed the limit.");
    }
    await this.saveToDisk(target, next);
    return this.successResponse(target, "Write saved. This update is complete — do not repeat it.");
  }

  async remove(target: Target, oldText: string): Promise<MemoryResult> {
    const needle = (oldText ?? "").trim();
    if (!needle) return { success: false, error: "remove requires old_text." };
    await this.syncFromDiskIfChanged(target);
    const matches = this.entries[target].filter((e) => e.includes(needle));
    if (matches.length === 0) {
      return { success: false, error: `No entry matched '${needle}'.`, current_entries: this.entries[target].map(preview) };
    }
    if (matches.length > 1) {
      return { success: false, error: `Multiple entries matched '${needle}'. Be more specific.`, matches: matches.map(preview) };
    }
    const next = this.entries[target].filter((e) => e !== matches[0]);
    await this.saveToDisk(target, next);
    return this.successResponse(target, "Write saved. This update is complete — do not repeat it.");
  }

  /** All-or-nothing batch; budget checked only on the final state (Hermes apply_batch). */
  async applyBatch(target: Target, operations: MemoryOperation[]): Promise<MemoryResult> {
    await this.syncFromDiskIfChanged(target);
    let planned = [...this.entries[target]];
    for (const op of operations) {
      const action = op.action;
      if (action === "add") {
        const text = (op.content ?? "").trim();
        if (!text) return { success: false, error: "Memory mutation add requires content." };
        if (planned.includes(text)) continue; // idempotent
        planned.push(text);
        continue;
      }
      const needle = (op.old_text ?? "").trim();
      if (!needle) return { success: false, error: `Memory mutation ${action} requires old_text.` };
      const matches = planned.filter((e) => e.includes(needle));
      if (matches.length === 0) return { success: false, error: `No entry matched '${needle}'.` };
      if (matches.length > 1) {
        return { success: false, error: `Multiple entries matched '${needle}'. Be more specific.`, matches: matches.map(preview) };
      }
      if (action === "remove") {
        planned = planned.filter((e) => e !== matches[0]);
        continue;
      }
      const text = (op.content ?? "").trim();
      if (!text) return { success: false, error: "Memory mutation replace requires content." };
      planned = planned.map((e) => (e === matches[0] ? text : e));
    }
    if (planned.join(ENTRY_DELIMITER).length > this.charLimit(target)) {
      return this.consolidationFailure(target, "Memory mutation plan would exceed the limit.");
    }
    await this.saveToDisk(target, planned);
    return this.successResponse(target, `Applied ${operations.length} memory operations atomically.`);
  }

  // ─── Atomic disk writes ───

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(task, task);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private saveToDisk(target: Target, entries: string[]): Promise<void> {
    return this.enqueueWrite(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.writeOnce(target, entries);
          this.entries[target] = entries;
          return;
        } catch (err) {
          await this.syncFromDiskIfChanged(target);
          if (!(err instanceof ExternalMemoryWriteConflict) || attempt >= MAX_EXTERNAL_WRITE_RETRIES) throw err;
        }
      }
    });
  }

  private async writeOnce(target: Target, entries: string[]): Promise<void> {
    const file = this.pathFor(target);
    const expected = this.fingerprints.get(file) ?? "missing";
    const content = entries.join(ENTRY_DELIMITER);
    await atomicWrite(file, content, expected);
    this.fingerprints.set(file, createHash("sha256").update(content).digest("hex"));
  }
}

// ─── Helpers ───

function preview(text: string): string {
  return text.slice(0, 80) + (text.length > 80 ? "..." : "");
}

/** Split §-delimited entries, tolerating the odd legacy `-->§\n` separator. */
export function splitEntries(content: string): string[] {
  return content
    .split(/\n?§\n/)
    .map((e) => e.trim())
    .filter(Boolean);
}

async function fingerprint(file: string): Promise<string> {
  try {
    return createHash("sha256").update(await fs.readFile(file)).digest("hex");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw e;
  }
}

/** Atomic write: temp file + rename (same dir), with a fingerprint guard. */
async function atomicWrite(filePath: string, content: string, expectedFingerprint: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(dir, ".hm-tmp-"));
  const tmpPath = path.join(tmpDir, "write.tmp");
  const newFingerprint = createHash("sha256").update(content).digest("hex");
  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    const current = await fingerprint(filePath);
    if (current !== expectedFingerprint) throw new ExternalMemoryWriteConflict();
    if (expectedFingerprint === "missing") {
      try {
        await fs.link(tmpPath, filePath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ExternalMemoryWriteConflict();
        throw e;
      }
    } else {
      await fs.rename(tmpPath, filePath);
    }
    if ((await fingerprint(filePath)) !== newFingerprint) throw new ExternalMemoryWriteConflict();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
