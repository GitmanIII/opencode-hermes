/**
 * opencode-hermes — V2 plugin entrypoint (`@opencode/plugin`).
 *
 * Thin adapter over `lib/core.ts`. V1 and V2 drive the same core; only the host
 * surface differs:
 *   - context injection      V1 `experimental.chat.system.transform` → V2 `session.hook("context")`
 *   - per-turn recall        V1 `chat.message`                      → V2 `session.hook("prompt")`
 *   - background learning    V1 `event`                             → V2 `event.subscribe()`
 *   - flush before compaction V1 `experimental.session.compacting`  → V2 `session.hook("compaction")`
 *   - tools                  V1 `tool()` map                        → V2 `tool.transform(...)`
 *   - completion             V1 internal session                    → V2 `generate.text(...)`
 */
import { Plugin } from "@opencode/plugin";
import type { ReviewChannel, TranscriptMessage } from "./lib/channel.ts";
import { createHermesCore } from "./lib/core.ts";
import { createFileLogger } from "./lib/log.ts";
import {
  jsonSchema,
  TOOL_SPECS,
  type MemoryArgs,
  type ProviderMemoryArgs,
  type SessionSearchArgs,
  type SkillManageArgs,
} from "./lib/tool-specs.ts";

/** Shape of `ctx.session.context()` rows, narrowed to what the transcript uses. */
type V2Message = {
  type?: string;
  text?: string;
  status?: string;
  model?: { id?: string };
  content?: Array<{ type?: string; text?: string }>;
};

export function toTranscriptMessage(msg: V2Message): TranscriptMessage | undefined {
  switch (msg.type) {
    case "user":
      return { role: "user", text: (msg.text ?? "").trim() };
    case "assistant": {
      const text = (msg.content ?? [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text!.trim())
        .filter(Boolean)
        .join("\n");
      return { role: "assistant", text, modelID: msg.model?.id };
    }
    case "synthetic":
      // Hermes' own injected recall notes carry no user intent.
      return { role: "user", text: "" };
    case "compaction":
      return msg.status === "completed" ? { role: "assistant", text: "", summary: true } : undefined;
    default:
      // system / idle / shell / skill / agent- and model-switch markers
      return undefined;
  }
}

export function toTranscript(messages: readonly V2Message[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const msg of messages) {
    const mapped = toTranscriptMessage(msg);
    if (mapped) out.push(mapped);
  }
  return out;
}

type V2EventLocation = { directory?: string; workspaceID?: string };
type V2Event = { type: string; data?: { sessionID?: string }; location?: V2EventLocation };

/**
 * `ctx.location` is where this plugin instance loaded, not the location of every
 * event it receives (V2 docs). Session events carry `location`; ignore events
 * from other workspaces/directories so a review can never use this instance's
 * project id/provider scope for another project.
 */
export function isSameLocation(
  eventLocation: V2EventLocation | undefined,
  own: { directory: string; workspaceID?: string; project?: { directory?: string; canonical?: string } },
): boolean {
  if (!eventLocation) return true;
  if (eventLocation.workspaceID && own.workspaceID) return eventLocation.workspaceID === own.workspaceID;
  if (!eventLocation.directory) return true;
  return (
    eventLocation.directory === own.directory ||
    eventLocation.directory === own.project?.directory ||
    eventLocation.directory === own.project?.canonical
  );
}

function isExecutionEvent(type: string): boolean {
  return (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted"
  );
}

/** Adapt the V2 plugin context to the host-agnostic `ReviewChannel`. */
function createV2Channel(ctx: Plugin.Context, log: (msg: string) => void): ReviewChannel {
  // Review completions must run on the model the reviewed session actually used.
  // `generate.text` without a model picks the global default, which here is a
  // free-tier model that rejects requests ("free tier can only be used from
  // within OpenCode") — so the review would run and save nothing. Resolve once
  // per session; the dream judge calls complete() many times.
  const modelOf = new Map<string, { id: string; providerID: string; variant?: string } | undefined>();

  async function reviewedModel(sessionID: string | undefined) {
    if (!sessionID) return undefined;
    if (modelOf.has(sessionID)) return modelOf.get(sessionID);
    let model: { id: string; providerID: string; variant?: string } | undefined;
    try {
      model = (await ctx.session.get({ sessionID })).model;
    } catch {
      model = undefined;
    }
    modelOf.set(sessionID, model);
    return model;
  }

  return {
    async transcript(sessionID) {
      return toTranscript((await ctx.session.context({ sessionID })) as V2Message[]);
    },

    async complete(system, user, sessionID) {
      try {
        // V2 generates without a session; fold the system prompt into the only
        // free-form input and pin the reviewed session's model.
        const model = await reviewedModel(sessionID);
        const out = await ctx.generate.text({ ...(model ? { model } : {}), prompt: `${system}\n\n${user}` });
        return { text: (out.text ?? "").trim() };
      } catch (err) {
        return { text: "", error: String(err) };
      }
    },

    async sessionTitle(sessionID) {
      try {
        const info = await ctx.session.get({ sessionID });
        return (info as { title?: string }).title;
      } catch {
        return undefined;
      }
    },

    async injectNote(sessionID, text) {
      await ctx.session.synthetic({ sessionID, text });
    },

    async toast(message) {
      // V2 has no server-side toast API (only the `tui.toast.show` event), so the
      // notice goes to the plugin log.
      log(`toast: ${message}`);
    },
  };
}

export const plugin = Plugin.define({
  id: "opencode-hermes",
  async setup(ctx) {
    const log = createFileLogger();
    const directory = ctx.location.directory;
    const projectId = ctx.location.project.id;

    const core = await createHermesCore({ channel: createV2Channel(ctx, log), directory, projectId, log });

    // ─── Whole-file memory injection ───
    await ctx.session.hook("context", (event) => {
      for (const block of core.systemBlocks()) event.system.push({ type: "text", text: block });
    });

    // ─── Turn counter + per-turn failure-cap reset + provider prefetch ───
    await ctx.session.hook("prompt", async (event) => {
      await core.onPrompt(event.sessionID, event.prompt.text);
    });

    // ─── Flush review before compaction ───
    await ctx.session.hook("compaction", async (event) => {
      const note = await core.onCompaction(event.sessionID);
      if (note) event.system.push({ type: "text", text: note });
    });

    // ─── Background learning when a turn finishes ───
    // V2 reports "the session is idle again" with the durable execution events.
    // The schema's `session.idle` event is transient and does not reach plugin
    // subscribers in 2.0.32 (verified: the server writes an `idle` message row
    // and emits execution.succeeded, but no session.idle/status), so trigger on
    // the execution result instead — same moment V1's `session.idle` fired.
    const controller = new AbortController();
    const queue: V2Event[] = [];
    const EVENT_QUEUE_LIMIT = 1000;
    let draining = false;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (controller.signal.aborted) return resolve();
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });

    const handleEvent = async (event: V2Event) => {
      if (!isSameLocation(event.location, ctx.location)) return;
      if (event.type === "session.created") await core.onSessionCreated();
      else if (event.type === "session.deleted") {
        if (event.data?.sessionID) core.onSessionDeleted(event.data.sessionID);
      } else if (isExecutionEvent(event.type) && event.data?.sessionID) {
        await core.onIdle(event.data.sessionID);
      }
    };

    // The shared event source waits for each subscriber to accept an event, so
    // do only queue work here; the drain worker performs the slow disk/network
    // calls without backpressuring the stream.
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        while (queue.length && !controller.signal.aborted) {
          const event = queue.shift()!;
          try {
            await handleEvent(event);
          } catch (err) {
            log(`event handler error: ${String(err)}`);
          }
        }
      } finally {
        draining = false;
        if (queue.length && !controller.signal.aborted) void drain();
      }
    };

    const enqueue = (event: V2Event) => {
      if (controller.signal.aborted) return;
      if (queue.length >= EVENT_QUEUE_LIMIT) {
        queue.shift();
        log(`event queue full (${EVENT_QUEUE_LIMIT}); dropped the oldest event`);
      }
      queue.push(event);
      void drain();
    };

    // V2 subscriptions are live-only: no replay and no automatic reconnect. Keep
    // the subscriber loop alive with backoff so a dropped stream cannot silently
    // disable background learning until the next restart.
    void (async () => {
      let backoff = 500;
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            backoff = 500;
            enqueue(event as V2Event);
          }
          if (controller.signal.aborted) break;
          log("event subscription ended; reconnecting");
        } catch (err) {
          if (controller.signal.aborted) break;
          log(`event subscription failed: ${String(err)}; reconnecting in ${backoff}ms`);
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    })();

    // ─── Tools ───
    const executors = core.executors;
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory",
        description: TOOL_SPECS.memory.description,
        input: jsonSchema(TOOL_SPECS.memory),
        execute: async (input) => ({ content: await executors.memory(input as MemoryArgs) }),
      });
      editor.add({
        name: "session_search",
        description: TOOL_SPECS.session_search.description,
        input: jsonSchema(TOOL_SPECS.session_search),
        execute: async (input) => ({ content: await executors.session_search(input as SessionSearchArgs) }),
      });
      // Registered only when a provider is active: with none it would be a dead
      // tool (always erroring) cluttering the surface.
      if (core.providerActive) {
        editor.add({
          name: "provider_memory",
          description: TOOL_SPECS.provider_memory.description,
          input: jsonSchema(TOOL_SPECS.provider_memory),
          execute: async (input) => ({ content: await executors.provider_memory(input as ProviderMemoryArgs) }),
        });
      }
      editor.add({
        name: "skill_manage",
        description: TOOL_SPECS.skill_manage.description,
        input: jsonSchema(TOOL_SPECS.skill_manage),
        execute: async (input) => ({ content: await executors.skill_manage(input as SkillManageArgs) }),
      });
    });

    // ─── Cleanup ───
    return () => {
      controller.abort();
      queue.length = 0;
      core.dispose();
    };
  },
});

export default plugin;
