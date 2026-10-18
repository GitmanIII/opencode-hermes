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

/** Adapt the V2 plugin context to the host-agnostic `ReviewChannel`. */
function createV2Channel(ctx: Plugin.Context, log: (msg: string) => void): ReviewChannel {
  return {
    async transcript(sessionID) {
      return toTranscript((await ctx.session.context({ sessionID })) as V2Message[]);
    },

    async complete(system, user) {
      try {
        // V2 generates without a session; fold the system prompt into the only
        // free-form input and let the default model resolve.
        const out = await ctx.generate.text({ prompt: `${system}\n\n${user}` });
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

    // ─── Background learning on idle ───
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.created") await core.onSessionCreated();
          else if (event.type === "session.deleted") core.onSessionDeleted(event.data.sessionID);
          else if (event.type === "session.idle") await core.onIdle(event.data.sessionID);
        }
      } catch (err) {
        if (!controller.signal.aborted) log(`event subscription failed: ${String(err)}`);
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
      core.dispose();
    };
  },
});

export default plugin;
