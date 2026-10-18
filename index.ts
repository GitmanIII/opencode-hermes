/**
 * opencode-hermes — V1 plugin entrypoint.
 *
 * Thin adapter over `lib/core.ts`: the V1 hook keys, the V1 `tool()` schemas, and
 * the V1 client. The V2 entrypoint (`v2.ts`) drives the same core through
 * `@opencode/plugin`. The default export exposes both APIs (V2 `id` + `setup`
 * from `v2.ts`, V1 `server()` here) so one entry works on either host.
 */
import * as path from "node:path";
import { tool, type Plugin } from "@opencode-ai/plugin";
import { createHermesCore, type HermesCore } from "./lib/core.ts";
import { createFileLogger } from "./lib/log.ts";
import { createV1Channel, isInternalSessionId } from "./lib/llm.ts";
import v2 from "./v2.ts";
import {
  MEMORY_ACTIONS,
  TOOL_SPECS,
  type MemoryArgs,
  type ProviderMemoryArgs,
  type SessionSearchArgs,
  type SkillManageArgs,
  type ToolSpec,
} from "./lib/tool-specs.ts";

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

/** Render the shared tool spec into the zod raw shape V1 `tool()` expects. */
function v1Args(spec: ToolSpec): Record<string, any> {
  const args: Record<string, any> = {};
  for (const [name, field] of Object.entries(spec.fields)) {
    let schema: any;
    switch (field.type) {
      case "number":
        schema = tool.schema.number();
        break;
      case "boolean":
        schema = tool.schema.boolean();
        break;
      case "enum":
        schema = tool.schema.enum(field.values as [string, ...string[]]);
        break;
      case "stringArray":
        schema = tool.schema.array(tool.schema.string());
        break;
      case "operations":
        schema = tool.schema.array(
          tool.schema.object({
            action: tool.schema.enum(MEMORY_ACTIONS as unknown as [string, ...string[]]),
            content: tool.schema.string().optional(),
            old_text: tool.schema.string().optional(),
          }),
        );
        break;
      default:
        schema = tool.schema.string();
    }
    args[name] = field.optional ? schema.optional().describe(field.description) : schema.describe(field.description);
  }
  return args;
}

function v1Tools(core: HermesCore) {
  return {
    memory: tool({
      description: TOOL_SPECS.memory.description,
      args: v1Args(TOOL_SPECS.memory),
      execute: (args) => core.executors.memory(args as MemoryArgs),
    }),
    session_search: tool({
      description: TOOL_SPECS.session_search.description,
      args: v1Args(TOOL_SPECS.session_search),
      execute: (args) => core.executors.session_search(args as SessionSearchArgs),
    }),
    // Registered only when a provider is active: with none it would be a dead
    // tool (always erroring) cluttering the surface.
    ...(core.providerActive
      ? {
          provider_memory: tool({
            description: TOOL_SPECS.provider_memory.description,
            args: v1Args(TOOL_SPECS.provider_memory),
            execute: (args) => core.executors.provider_memory(args as ProviderMemoryArgs),
          }),
        }
      : {}),
    skill_manage: tool({
      description: TOOL_SPECS.skill_manage.description,
      args: v1Args(TOOL_SPECS.skill_manage),
      execute: (args) => core.executors.skill_manage(args as SkillManageArgs),
    }),
  };
}

const plugin: Plugin = async ({ client, project, directory }) => {
  const log = createFileLogger();

  const core = await createHermesCore({
    channel: createV1Channel(client, directory),
    directory,
    projectId: projectIdOf(project, directory),
    log,
    isInternalSession: isInternalSessionId,
  });

  return {
    // ─── Whole-file memory injection ───
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        output.system.push(...core.systemBlocks());
      } catch (err) {
        log(`system.transform error: ${String(err)}`);
      }
    },

    // ─── Turn counter + per-turn failure-cap reset + provider prefetch ───
    "chat.message": async (input, output) => {
      await core.onPrompt(input.sessionID, textParts((output as { parts?: TextPartLike[] } | undefined)?.parts));
    },

    // ─── Background learning on idle ───
    event: async (input) => {
      const event = input.event;
      try {
        if (event.type === "session.created") {
          await core.onSessionCreated();
          return;
        }
        if (event.type === "session.deleted") {
          const info = (event.properties as { info?: { id?: string } } | undefined)?.info;
          if (info?.id) core.onSessionDeleted(info.id);
          return;
        }
        if (event.type !== "session.idle") return;
        const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID;
        if (!sessionID) return;
        await core.onIdle(sessionID);
      } catch (err) {
        log(`event handler error: ${String(err)}`);
      }
    },

    // ─── Flush review before compaction ───
    "experimental.session.compacting": async (input, output) => {
      const sessionID = (input as { sessionID?: string }).sessionID;
      if (!sessionID || isInternalSessionId(sessionID)) return;
      const note = await core.onCompaction(sessionID);
      if (note) output.context.push(note);
    },

    tool: v1Tools(core),

    // ─── Cleanup ───
    dispose: async () => core.dispose(),
  };
};

export default {
  ...v2,
  id: "opencode-hermes",
  server: plugin,
};
