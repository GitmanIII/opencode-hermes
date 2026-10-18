/**
 * opencode-hermes — host-agnostic core lifecycle.
 *
 * Owns the store, the optional provider, the frozen system-prompt snapshot, the
 * turn counter, and the idle/flush review triggers. Both entrypoints (`index.ts`
 * for the V1 plugin API, `v2.ts` for V2) drive this same core so the learning
 * loop behaves identically on either host; the only host-specific pieces are the
 * `ReviewChannel` and the hook/tool registration.
 */
import * as path from "node:path";
import type { ReviewChannel } from "./channel.ts";import { configWarnings, loadConfig } from "./config.ts";
import { clearSession, clearSessionState, runBackgroundReview, runDream, runFlushReview, setDebugLogger } from "./learn.ts";
import { isInternalSession as isInternalSessionTitle } from "./llm.ts";
import { MemoryManager } from "./memory-manager.ts";
import { loadProvider, type MemoryProvider } from "./memory-provider.ts";
import { memoryRoot, skillsRoot } from "./paths.ts";
import { SESSION_SEARCH_GUIDANCE } from "./prompts.ts";
import { MemoryStore } from "./store.ts";
import { createToolExecutors, type ToolExecutors } from "./tool-specs.ts";

const IDLE_DEBOUNCE_MS = 10_000;
const REVIEW_MIN_INTERVAL_MS = 30 * 60 * 1000;

const MEMORY_GUIDANCE =
  "You have persistent memory across sessions. The MEMORY and USER blocks in this system prompt are your saved notes and the user's profile; keep them current with the `memory` tool. Reusable procedures belong in a skill, not memory.";

export type HermesCoreOptions = {
  channel: ReviewChannel;
  directory: string;
  /** Project id used for provider scoping and review prompts. */
  projectId: string;
  log: (msg: string) => void;
  /** V1 reviews run in real internal sessions; V2 generates without a session. */
  isInternalSession?: (sessionID: string) => boolean;
};

export type HermesCore = {
  /** System-prompt blocks (guidance, provider recall, frozen MEMORY/USER snapshot). */
  systemBlocks(): string[];
  /** A user turn: reset failure caps, count turns, inject provider recall. */
  onPrompt(sessionID: string, text: string): Promise<void>;
  onSessionCreated(): Promise<void>;
  onSessionDeleted(sessionID: string): void;
  onIdle(sessionID: string): Promise<void>;
  /** Flush review before compaction; returns a note to append when items were saved. */
  onCompaction(sessionID: string): Promise<string | undefined>;
  executors: ToolExecutors;
  providerActive: boolean;
  dispose(): void;
};

export async function createHermesCore(opts: HermesCoreOptions): Promise<HermesCore> {
  const { channel, directory, projectId, log } = opts;
  const isInternalSession = opts.isInternalSession ?? (() => false);
  const CONFIG = loadConfig();
  const NUDGE_INTERVAL = CONFIG.nudgeInterval;
  const DREAM = CONFIG.dream;
  const DREAM_JUDGE = CONFIG.dreamJudge;

  const store = new MemoryStore({ memoryCharLimit: CONFIG.memoryCharLimit, userCharLimit: CONFIG.userCharLimit });
  await store.loadFromDisk().catch((err) => log(`store load failed: ${String(err)}`));
  setDebugLogger((msg) => log(msg));
  // A malformed config file silently fell back to defaults before — say so.
  for (const warning of configWarnings()) log(`config: ${warning}`);

  let provider: MemoryProvider | null = null;
  try {
    provider = await loadProvider(CONFIG.provider, CONFIG.providerOptions);
    if (provider) {
      await provider.initialize({
        memoryRoot: memoryRoot(),
        providerPath: CONFIG.providerPath ?? path.join(memoryRoot(), "provider.sqlite"),
        prefetchLimit: CONFIG.prefetchLimit,
        options: CONFIG.providerOptions,
        projectId,
      });
      provider.setProject?.(projectId);
    }
  } catch (err) {
    log(`provider '${CONFIG.provider}' init failed: ${String(err)}`);
    provider = null;
  }
  const manager = new MemoryManager(provider, (msg) => log(msg));

  log(
    `initialized (project=${projectId}, dir=${directory}) config: memory=${CONFIG.memoryCharLimit} user=${CONFIG.userCharLimit} nudge=${CONFIG.nudgeInterval} provider=${manager.activeName()}`,
  );

  // Frozen system-prompt snapshot (Hermes): writes persist to disk but the
  // injected block only refreshes when a new session starts.
  let snapshot = store.formatForSystemPrompt();

  const sessionTurns = new Map<string, number>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastIdleSession: string | null = null;
  let lastReviewAt = 0;
  const dreamedSessions = new Set<string>();

  const executors = createToolExecutors({ store, manager, providerName: CONFIG.provider });

  return {
    systemBlocks() {
      const blocks = [MEMORY_GUIDANCE, SESSION_SEARCH_GUIDANCE];
      const providerBlock = manager.systemPromptBlock();
      if (providerBlock) blocks.push(providerBlock);
      blocks.push(snapshot);
      return blocks;
    },

    async onPrompt(sessionID, text) {
      try {
        if (isInternalSession(sessionID)) return;
        store.resetConsolidationFailures();
        sessionTurns.set(sessionID, (sessionTurns.get(sessionID) ?? 0) + 1);

        // Automatic recall: inject relevant provider notes before the model responds.
        const userText = text.trim();
        if (userText && manager.provider) {
          const block = await manager.prefetch(userText);
          if (block) {
            await channel.injectNote(sessionID, block).catch((err) => log(`provider prefetch inject failed: ${String(err)}`));
          }
        }
      } catch (err) {
        log(`prompt hook error: ${String(err)}`);
      }
    },

    async onSessionCreated() {
      // Pick up memory written by other OpenCode processes before freezing this
      // session's snapshot.
      await store.refresh().catch((err) => log(`store refresh failed: ${String(err)}`));
      snapshot = store.formatForSystemPrompt();
    },

    onSessionDeleted(sessionID) {
      sessionTurns.delete(sessionID);
      dreamedSessions.delete(sessionID);
      clearSession(sessionID);
      if (lastIdleSession === sessionID) lastIdleSession = null;
    },

    async onIdle(sessionID) {
      try {
        if (sessionID === lastIdleSession) return;
        if (isInternalSession(sessionID)) return;
        const title = await channel.sessionTitle(sessionID);
        if (isInternalSessionTitle(title)) return;
        const turns = sessionTurns.get(sessionID) ?? 0;
        if (turns < NUDGE_INTERVAL) return;
        if (Date.now() - lastReviewAt < REVIEW_MIN_INTERVAL_MS) return;

        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(async () => {
          try {
            const result = await runBackgroundReview(channel, store, projectId, sessionID, skillsRoot(), manager);
            lastReviewAt = Date.now();
            const savedSkills = result.savedSkills ?? 0;
            const savedMemory = result.savedCount - savedSkills;
            log(`background review: memory=${savedMemory} skills=${savedSkills}${result.error ? ` err=${result.error}` : ""}`);
            sessionTurns.set(sessionID, 0);
            if (result.savedCount > 0) {
              await channel.toast(`Saved ${savedMemory} memory + ${savedSkills} skill item(s)`).catch(() => {});
            }
            // Dream: reconcile the long-term store against current canonical memory
            // (once per session, only when the active provider supports it).
            if (DREAM && !dreamedSessions.has(sessionID)) {
              dreamedSessions.add(sessionID);
              const stats = await runDream(channel, store, manager, DREAM_JUDGE);
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
        log(`idle handler error: ${String(err)}`);
      }
    },

    async onCompaction(sessionID) {
      try {
        const result = await runFlushReview(channel, store, projectId, sessionID, skillsRoot(), manager);
        if (result.savedCount > 0) {
          const savedSkills = result.savedSkills ?? 0;
          return `opencode-hermes: saved ${result.savedCount - savedSkills} memory + ${savedSkills} skill item(s) before compaction.`;
        }
      } catch (err) {
        log(`compaction hook error: ${String(err)}`);
      }
      return undefined;
    },

    executors,
    providerActive: Boolean(manager.provider),

    dispose() {
      if (idleTimer) clearTimeout(idleTimer);
      sessionTurns.clear();
      clearSessionState();
      manager.shutdown();
      log("disposed");
    },
  };
}
