/**
 * opencode-hermes — plugin entry (Hermes core).
 *
 * Faithful to Hermes' built-in memory:
 *   - MEMORY.md + USER.md, injected WHOLE into the system prompt (frozen
 *     snapshot per session), char-capped.
 *   - a single `memory` tool (add/replace/remove/demote + atomic batch).
 *   - a background review on session idle that writes memory and skills.
 *   - an optional "dream" that reconciles the long-term provider store against
 *     the current canonical facts (superseding stale/duplicate notes).
 * Skills (procedural memory) are managed with skill_* tools.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  clearSession,
  clearSessionState,
  runBackgroundReview,
  runDream,
  runFlushReview,
  setDebugLogger,
} from "./lib/learn.ts";
import { isInternalSession, isInternalSessionId } from "./lib/llm.ts";
import { configWarnings, loadConfig } from "./lib/config.ts";
import { MEMORY_TOOL_DESCRIPTION, SESSION_SEARCH_GUIDANCE, SESSION_SEARCH_TOOL_DESCRIPTION } from "./lib/prompts.ts";
import { sessionSearch, sessionsDbPath } from "./lib/session-search.ts";
import { memoryRoot, skillsRoot } from "./lib/paths.ts";
import { loadProvider, type MemoryProvider } from "./lib/memory-provider.ts";
import { MemoryManager } from "./lib/memory-manager.ts";
import { type MemoryOperation, MemoryStore, type Target } from "./lib/store.ts";
import { curateSkills, manageSkill, restoreSkill } from "./lib/skills.ts";

const LOG_FILE =
  process.env.HERMES_OPENCODE_LOG ?? path.join(process.env.HOME ?? ".", ".local", "share", "opencode", "log", "opencode-hermes.log");
const LOG_MAX_BYTES = 1 * 1024 * 1024;
const LOG_ROTATE_CHECK_INTERVAL_MS = 30_000;
const CONFIG = loadConfig();
const NUDGE_INTERVAL = CONFIG.nudgeInterval;
const IDLE_DEBOUNCE_MS = 10_000;
const REVIEW_MIN_INTERVAL_MS = 30 * 60 * 1000;
const DREAM = CONFIG.dream;
const DREAM_JUDGE = CONFIG.dreamJudge;

const MEMORY_GUIDANCE =
  "You have persistent memory across sessions. The MEMORY and USER blocks in this system prompt are your saved notes and the user's profile; keep them current with the `memory` tool. Reusable procedures belong in a skill, not memory.";

let lastRotateCheckAt = 0;
function rotateLog(): void {
  const now = Date.now();
  if (now - lastRotateCheckAt < LOG_ROTATE_CHECK_INTERVAL_MS) return;
  lastRotateCheckAt = now;
  try {
    let stat: ReturnType<typeof fs.statSync> | undefined;
    try {
      stat = fs.statSync(LOG_FILE);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size < LOG_MAX_BYTES) return;
    fs.rmSync(`${LOG_FILE}.2`, { force: true });
    if (fs.existsSync(`${LOG_FILE}.1`)) fs.renameSync(`${LOG_FILE}.1`, `${LOG_FILE}.2`);
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* ignore */
  }
}

function log(msg: string): void {
  try {
    rotateLog();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function projectIdOf(project: { id?: string } | undefined, directory: string): string {
  if (project?.id) return project.id;
  return path.basename(directory) || "default";
}

type TextPartLike = { type?: string; text?: unknown; synthetic?: boolean };
function textParts(parts: TextPartLike[] | undefined): string {
  return (parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p) => p.text as string)
    .join("\n");
}

const plugin: Plugin = async ({ client, project, directory }) => {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch {
    /* ignore */
  }
  const store = new MemoryStore({ memoryCharLimit: CONFIG.memoryCharLimit, userCharLimit: CONFIG.userCharLimit });
  await store.loadFromDisk().catch((err) => log(`store load failed: ${String(err)}`));
  setDebugLogger((msg) => log(msg));
  // A malformed config file silently fell back to defaults before — say so.
  for (const warning of configWarnings()) log(`config: ${warning}`);

  const currentProject = projectIdOf(project, directory);
  let provider: MemoryProvider | null = null;
  try {
    provider = await loadProvider(CONFIG.provider, CONFIG.providerOptions);
    if (provider) {
      await provider.initialize({
        memoryRoot: memoryRoot(),
        providerPath: CONFIG.providerPath ?? path.join(memoryRoot(), "provider.sqlite"),
        prefetchLimit: CONFIG.prefetchLimit,
        options: CONFIG.providerOptions,
        projectId: currentProject,
      });
      provider.setProject?.(currentProject);
    }
  } catch (err) {
    log(`provider '${CONFIG.provider}' init failed: ${String(err)}`);
    provider = null;
  }
  const manager = new MemoryManager(provider, (msg) => log(msg));

  log(
    `initialized (project=${currentProject}, dir=${directory}) config: memory=${CONFIG.memoryCharLimit} user=${CONFIG.userCharLimit} nudge=${CONFIG.nudgeInterval} provider=${manager.activeName()}`,
  );

  // Frozen system-prompt snapshot (Hermes): writes persist to disk but the
  // injected block only refreshes when a new session starts.
  let snapshot = store.formatForSystemPrompt();

  const sessionTurns = new Map<string, number>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastIdleSession: string | null = null;
  let lastReviewAt = 0;
  const dreamedSessions = new Set<string>();

  return {
    // ─── Whole-file memory injection ───
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        output.system.push(MEMORY_GUIDANCE);
        output.system.push(SESSION_SEARCH_GUIDANCE);
        const providerBlock = manager.systemPromptBlock();
        if (providerBlock) output.system.push(providerBlock);
        output.system.push(snapshot);
      } catch (err) {
        log(`system.transform error: ${String(err)}`);
      }
    },

    // ─── Turn counter + per-turn failure-cap reset + provider prefetch ───
    "chat.message": async (input, output) => {
      try {
        if (isInternalSessionId(input.sessionID)) return;
        store.resetConsolidationFailures();
        sessionTurns.set(input.sessionID, (sessionTurns.get(input.sessionID) ?? 0) + 1);

        // Automatic recall: inject relevant provider notes before the model responds.
        const userText = textParts((output as { parts?: TextPartLike[] } | undefined)?.parts).trim();
        if (userText && manager.provider) {
          const block = await manager.prefetch(userText);
          if (block) {
            await client.session
              .prompt({
                path: { id: input.sessionID },
                body: { parts: [{ id: `prt-pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: "text", text: block, synthetic: true }], noReply: true },
              })
              .catch((err) => log(`provider prefetch inject failed: ${String(err)}`));
          }
        }
      } catch (err) {
        log(`chat.message error: ${String(err)}`);
      }
    },

    // ─── Background learning on idle ───
    event: async (input) => {
      const event = input.event;
      try {
        if (event.type === "session.created") {
          // Pick up memory written by other OpenCode processes before freezing
          // this session's snapshot.
          await store.refresh().catch((err) => log(`store refresh failed: ${String(err)}`));
          snapshot = store.formatForSystemPrompt();
          return;
        }
        if (event.type === "session.deleted") {
          const info = (event.properties as { info?: { id?: string } } | undefined)?.info;
          if (info?.id) {
            sessionTurns.delete(info.id);
            dreamedSessions.delete(info.id);
            clearSession(info.id);
            if (lastIdleSession === info.id) lastIdleSession = null;
          }
          return;
        }
        if (event.type !== "session.idle") return;
        const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID;
        if (!sessionID) return;
        if (sessionID === lastIdleSession) return;
        if (isInternalSessionId(sessionID)) return;
        try {
          const info = await client.session.get({ path: { id: sessionID } });
          if (isInternalSession(info.data?.title)) return;
        } catch {
          /* ignore */
        }
        const turns = sessionTurns.get(sessionID) ?? 0;
        if (turns < NUDGE_INTERVAL) return;
        if (Date.now() - lastReviewAt < REVIEW_MIN_INTERVAL_MS) return;

        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(async () => {
          try {
            const result = await runBackgroundReview(client, store, directory, projectIdOf(project, directory), sessionID, skillsRoot(), manager);
            lastReviewAt = Date.now();
            const savedSkills = result.savedSkills ?? 0;
            const savedMemory = result.savedCount - savedSkills;
            log(`background review: memory=${savedMemory} skills=${savedSkills}${result.error ? ` err=${result.error}` : ""}`);
            sessionTurns.set(sessionID, 0);
            if (result.savedCount > 0) {
              await client.tui
                ?.showToast({
                  body: { title: "opencode-hermes", message: `Saved ${savedMemory} memory + ${savedSkills} skill item(s)`, variant: "info", duration: 4000 },
                })
                .catch(() => {});
            }
            // Dream: reconcile the long-term store against current canonical memory
            // (once per session, only when the active provider supports it).
            if (DREAM && !dreamedSessions.has(sessionID)) {
              dreamedSessions.add(sessionID);
              const stats = await runDream(client, store, directory, manager, DREAM_JUDGE);
              if (stats) log(`dream: canonical=${stats.canonical} added=${stats.added} superseded=${stats.superseded} judged=${stats.judged} removed=${stats.removed}`);
            }
          } catch (err) {
            log(`background review threw: ${String(err)}`);
          } finally {
            idleTimer = null;
            if (lastIdleSession === sessionID) lastIdleSession = null;
          }
        }, IDLE_DEBOUNCE_MS);
        lastIdleSession = sessionID;
      } catch (err) {
        log(`event handler error: ${String(err)}`);
      }
    },

    // ─── Flush review before compaction ───
    "experimental.session.compacting": async (input, output) => {
      try {
        const sessionID = (input as { sessionID?: string }).sessionID;
        if (!sessionID || isInternalSessionId(sessionID)) return;
        const result = await runFlushReview(client, store, directory, projectIdOf(project, directory), sessionID, skillsRoot(), manager);
        if (result.savedCount > 0) {
          const savedSkills = result.savedSkills ?? 0;
          output.context.push(`opencode-hermes: saved ${result.savedCount - savedSkills} memory + ${savedSkills} skill item(s) before compaction.`);
        }
      } catch (err) {
        log(`session.compacting error: ${String(err)}`);
      }
    },

    // ─── Tools ───
    tool: {
      memory: tool({
        description: MEMORY_TOOL_DESCRIPTION,
        args: {
          target: tool.schema.enum(["memory", "user"]).optional().describe("memory = your notes; user = who the user is."),
          action: tool.schema.enum(["add", "replace", "remove", "demote"]).optional().describe("Single operation (omit when using operations[]). remove = wrong/superseded; demote = still useful, free room but keep recallable."),
          content: tool.schema.string().optional().describe("Entry text (add/replace)."),
          old_text: tool.schema.string().optional().describe("Substring to match (replace/remove/demote)."),
          operations: tool.schema
            .array(
              tool.schema.object({
                action: tool.schema.enum(["add", "replace", "remove", "demote"]),
                content: tool.schema.string().optional(),
                old_text: tool.schema.string().optional(),
              }),
            )
            .optional()
            .describe("Atomic batch applied to `target`; budget checked on the final result."),
        },
        async execute(args) {
          const target = (args.target ?? "memory") as Target;
          if (target !== "memory" && target !== "user") return JSON.stringify({ success: false, error: `invalid target '${target}'.` });
          try {
            if (Array.isArray(args.operations) && args.operations.length > 0) {
              const result = await store.applyBatch(target, args.operations as MemoryOperation[]);
              if (result.success) await manager.mirrorResolved(result.resolved);
              return JSON.stringify(result);
            }
            if (args.action === "add") {
              const r = await store.add(target, args.content ?? "");
              if (r.success) await manager.onMemoryWrite("add", args.content ?? "");
              return JSON.stringify(r);
            }
            if (args.action === "replace") {
              const r = await store.replace(target, args.old_text ?? "", args.content ?? "");
              if (r.success) await manager.onMemoryWrite("replace", args.content ?? "", r.matched ?? args.old_text ?? "");
              return JSON.stringify(r);
            }
            if (args.action === "remove" || args.action === "demote") {
              const r = await store.remove(target, args.old_text ?? "");
              if (r.success) await manager.onMemoryWrite(args.action, r.matched ?? args.old_text ?? "");
              return JSON.stringify(r);
            }
            return JSON.stringify({ success: false, error: "specify action (add|replace|remove|demote) or a non-empty operations[]." });
          } catch (err) {
            return JSON.stringify({ success: false, error: String(err) });
          }
        },
      }),

      session_search: tool({
        description: SESSION_SEARCH_TOOL_DESCRIPTION,
        args: {
          query: tool.schema.string().optional().describe("Discovery search terms over past conversations."),
          session_id: tool.schema.string().optional().describe("Read this session, or scope a scroll."),
          around_message_id: tool.schema.string().optional().describe("With session_id: window of messages around this message id."),
          limit: tool.schema.number().optional().describe("Discovery/browse: max sessions (default 3, max 10)."),
        },
        async execute(args) {
          try {
            return JSON.stringify(
              sessionSearch(sessionsDbPath(), {
                query: args.query,
                session_id: args.session_id,
                around_message_id: args.around_message_id,
                limit: args.limit,
              }),
            );
          } catch (err) {
            return JSON.stringify({ success: false, error: String(err) });
          }
        },
      }),

      // Registered only when a provider is active: with none it would be a dead
      // tool (always erroring) cluttering the surface.
      ...(manager.provider ? { provider_memory: tool({
        description:
          "External long-term memory provider: search or add durable notes. Relevant notes are also injected automatically before each turn.",
        args: {
          action: tool.schema.enum(["search", "add", "forget"]).describe("Operation."),
          query: tool.schema.string().optional().describe("search: terms."),
          content: tool.schema.string().optional().describe("add: note text."),
          tags: tool.schema.array(tool.schema.string()).optional().describe("add: optional tags."),
          id: tool.schema.string().optional().describe("forget: note id."),
          limit: tool.schema.number().optional().describe("search: max results (default 5)."),
        },
        async execute(args) {
          if (!manager.provider) return JSON.stringify({ success: false, error: `no memory provider active (config provider=${CONFIG.provider})` });
          try {
            if (args.action === "add") {
              const r = await manager.add(args.content ?? "", args.tags);
              return JSON.stringify({ success: true, id: r?.id });
            }
            if (args.action === "search") {
              const results = await manager.search(args.query ?? "", args.limit);
              return JSON.stringify({ success: true, query: args.query ?? "", count: results.length, results });
            }
            if (args.action === "forget") {
              await manager.forget(args.id ?? "");
              return JSON.stringify({ success: true });
            }
            return JSON.stringify({ success: false, error: `unknown action '${args.action}'.` });
          } catch (err) {
            return JSON.stringify({ success: false, error: String(err) });
          }
        },
      }) } : {}),

      // skill_list/skill_view are intentionally not registered: opencode itself
      // lists skills in the system prompt and can read SKILL.md/support files
      // with the normal read tool. The internal helpers remain for the review.
      // Curate/restore are folded into skill_manage's action enum (rather than
      // separate tools) to keep the surface at 4 tools; both keep every function.
      skill_manage: tool({
        description:
          "Create or maintain a skill (procedural memory). Authoring actions: create, patch, edit, delete, write_file, remove_file (create when a complex task succeeded, an error was overcome, or a reusable workflow was discovered; patch when a skill is stale or missing a step). Lifecycle actions: curate (mark agent-created skills stale, archive very old ones; never touches user/pinned skills; dry_run previews) and restore (bring an archived skill back).",
        args: {
          action: tool.schema
            .enum(["create", "patch", "edit", "delete", "write_file", "remove_file", "curate", "restore"])
            .describe("Operation to perform."),
          name: tool.schema.string().optional().describe("Skill name (lowercase-hyphen, <=64 chars). Required except for 'curate'."),
          category: tool.schema.string().optional().describe("Category folder (create only)."),
          content: tool.schema
            .string()
            .optional()
            .describe("Full SKILL.md (create/edit); must start with --- frontmatter (name + description) and a non-empty body."),
          old_string: tool.schema.string().optional().describe("patch: exact text to replace."),
          new_string: tool.schema.string().optional().describe("patch: replacement text."),
          replace_all: tool.schema.boolean().optional().describe("patch: replace every occurrence."),
          file_path: tool.schema.string().optional().describe("write_file/remove_file: path under references/, scripts/, templates/, or assets/."),
          file_content: tool.schema.string().optional().describe("write_file: file contents."),
          dry_run: tool.schema.boolean().optional().describe("curate: preview only; change nothing."),
          stale_after_days: tool.schema.number().optional().describe("curate: mark stale after N days inactive (default 30)."),
          archive_after_days: tool.schema.number().optional().describe("curate: archive after N days inactive (default 90)."),
        },
        async execute(args) {
          try {
            if (args.action === "curate") {
              const r = await curateSkills(skillsRoot(), {
                dryRun: args.dry_run,
                staleAfterDays: args.stale_after_days,
                archiveAfterDays: args.archive_after_days,
              });
              return JSON.stringify({ success: true, ...r });
            }
            const name = args.name;
            if (!name) return JSON.stringify({ success: false, error: `name is required for action '${args.action}'.` });
            if (args.action === "restore") return JSON.stringify(await restoreSkill(skillsRoot(), name));
            return JSON.stringify(
              await manageSkill(skillsRoot(), {
                action: args.action,
                name,
                category: args.category,
                content: args.content,
                oldString: args.old_string,
                newString: args.new_string,
                replaceAll: args.replace_all,
                filePath: args.file_path,
                fileContent: args.file_content,
              }),
            );
          } catch (err) {
            return JSON.stringify({ success: false, error: String(err) });
          }
        },
      }),
    },

    // ─── Cleanup ───
    dispose: async () => {
      if (idleTimer) clearTimeout(idleTimer);
      sessionTurns.clear();
      clearSessionState();
      manager.shutdown();
      log("disposed");
    },
  };
};

export default {
  id: "opencode-hermes",
  server: plugin,
};
