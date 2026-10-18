/**
 * opencode-hermes — tool definitions and executors, shared by the V1 and V2
 * entrypoints.
 *
 * Each tool is declared once as plain data (`TOOL_SPECS`) and rendered to the
 * schema language of whichever API loaded the plugin: zod for V1 `tool()` and
 * JSON Schema for V2 `ctx.tool.transform`. Executors are host-agnostic and
 * return the same JSON strings on both paths.
 */
import type { MemoryManager } from "./memory-manager.ts";
import { MEMORY_TOOL_DESCRIPTION, SESSION_SEARCH_TOOL_DESCRIPTION } from "./prompts.ts";
import { skillsRoot } from "./paths.ts";
import { sessionSearch, sessionsDbPath } from "./session-search.ts";
import { curateSkills, manageSkill, restoreSkill } from "./skills.ts";
import type { MemoryOperation, MemoryStore, Target } from "./store.ts";

export const MEMORY_ACTIONS = ["add", "replace", "remove", "demote"] as const;
export const SKILL_ACTIONS = ["create", "patch", "edit", "delete", "write_file", "remove_file", "curate", "restore"] as const;

export type FieldType = "string" | "number" | "boolean" | "enum" | "stringArray" | "operations";

export type FieldSpec = {
  type: FieldType;
  /** Allowed values for `enum`. */
  values?: readonly string[];
  /** Absent/false means the field is required. */
  optional?: boolean;
  description: string;
};

export type ToolSpec = { description: string; fields: Record<string, FieldSpec> };

export type ToolName = "memory" | "session_search" | "provider_memory" | "skill_manage";

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  memory: {
    description: MEMORY_TOOL_DESCRIPTION,
    fields: {
      target: { type: "enum", optional: true, values: ["memory", "user"], description: "memory = your notes; user = who the user is." },
      action: {
        type: "enum",
        optional: true,
        values: MEMORY_ACTIONS,
        description:
          "Single operation (omit when using operations[]). remove = wrong/superseded; demote = still useful, free room but keep recallable.",
      },
      content: { type: "string", optional: true, description: "Entry text (add/replace)." },
      old_text: { type: "string", optional: true, description: "Substring to match (replace/remove/demote)." },
      operations: {
        type: "operations",
        optional: true,
        description: "Atomic batch applied to `target`; budget checked on the final result.",
      },
    },
  },
  session_search: {
    description: SESSION_SEARCH_TOOL_DESCRIPTION,
    fields: {
      query: { type: "string", optional: true, description: "Discovery search terms over past conversations." },
      session_id: { type: "string", optional: true, description: "Read this session, or scope a scroll." },
      around_message_id: { type: "string", optional: true, description: "With session_id: window of messages around this message id." },
      limit: { type: "number", optional: true, description: "Discovery/browse: max sessions (default 3, max 10)." },
    },
  },
  provider_memory: {
    description:
      "External long-term memory provider: search or add durable notes. Relevant notes are also injected automatically before each turn.",
    fields: {
      action: { type: "enum", values: ["search", "add", "forget"], description: "Operation." },
      query: { type: "string", optional: true, description: "search: terms." },
      content: { type: "string", optional: true, description: "add: note text." },
      tags: { type: "stringArray", optional: true, description: "add: optional tags." },
      id: { type: "string", optional: true, description: "forget: note id." },
      limit: { type: "number", optional: true, description: "search: max results (default 5)." },
    },
  },
  skill_manage: {
    description:
      "Create or maintain a skill (procedural memory). Authoring actions: create, patch, edit, delete, write_file, remove_file (create when a complex task succeeded, an error was overcome, or a reusable workflow was discovered; patch when a skill is stale or missing a step). Lifecycle actions: curate (mark agent-created skills stale, archive very old ones; never touches user/pinned skills; dry_run previews) and restore (bring an archived skill back).",
    fields: {
      action: { type: "enum", values: SKILL_ACTIONS, description: "Operation to perform." },
      name: { type: "string", optional: true, description: "Skill name (lowercase-hyphen, <=64 chars). Required except for 'curate'." },
      category: { type: "string", optional: true, description: "Category folder (create only)." },
      content: {
        type: "string",
        optional: true,
        description: "Full SKILL.md (create/edit); must start with --- frontmatter (name + description) and a non-empty body.",
      },
      old_string: { type: "string", optional: true, description: "patch: exact text to replace." },
      new_string: { type: "string", optional: true, description: "patch: replacement text." },
      replace_all: { type: "boolean", optional: true, description: "patch: replace every occurrence." },
      file_path: { type: "string", optional: true, description: "write_file/remove_file: path under references/, scripts/, templates/, or assets/." },
      file_content: { type: "string", optional: true, description: "write_file: file contents." },
      dry_run: { type: "boolean", optional: true, description: "curate: preview only; change nothing." },
      stale_after_days: { type: "number", optional: true, description: "curate: mark stale after N days inactive (default 30)." },
      archive_after_days: { type: "number", optional: true, description: "curate: archive after N days inactive (default 90)." },
    },
  },
};

// ─── Schema rendering ───

/** JSON Schema form, for V2 `ctx.tool.transform(...)`. */
export function jsonSchema(spec: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(spec.fields)) {
    properties[name] = fieldJson(field);
    if (!field.optional) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function fieldJson(field: FieldSpec): Record<string, unknown> {
  switch (field.type) {
    case "number":
      return { type: "number", description: field.description };
    case "boolean":
      return { type: "boolean", description: field.description };
    case "enum":
      return { type: "string", enum: field.values, description: field.description };
    case "stringArray":
      return { type: "array", items: { type: "string" }, description: field.description };
    case "operations":
      return {
        type: "array",
        description: field.description,
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: MEMORY_ACTIONS, description: "Operation applied to `target`." },
            content: { type: "string", description: "Entry text (add/replace)." },
            old_text: { type: "string", description: "Substring to match (replace/remove/demote)." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      };
    default:
      return { type: "string", description: field.description };
  }
}

// ─── Executors ───

export type MemoryArgs = {
  target?: "memory" | "user";
  action?: "add" | "replace" | "remove" | "demote";
  content?: string;
  old_text?: string;
  operations?: Array<{ action: "add" | "replace" | "remove" | "demote"; content?: string; old_text?: string }>;
};
export type SessionSearchArgs = { query?: string; session_id?: string; around_message_id?: string; limit?: number };
export type ProviderMemoryArgs = { action: "search" | "add" | "forget"; query?: string; content?: string; tags?: string[]; id?: string; limit?: number };
export type SkillManageArgs = {
  action: (typeof SKILL_ACTIONS)[number];
  name?: string;
  category?: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  file_path?: string;
  file_content?: string;
  dry_run?: boolean;
  stale_after_days?: number;
  archive_after_days?: number;
};

export type ToolExecutors = {
  memory(args: MemoryArgs): Promise<string>;
  session_search(args: SessionSearchArgs): Promise<string>;
  provider_memory(args: ProviderMemoryArgs): Promise<string>;
  skill_manage(args: SkillManageArgs): Promise<string>;
};

export type ToolExecutorDeps = {
  store: MemoryStore;
  manager: MemoryManager;
  /** Configured provider name, surfaced in the no-provider error. */
  providerName: string;
};

/** Build the JSON-string-returning executors both entrypoints register. */
export function createToolExecutors({ store, manager, providerName }: ToolExecutorDeps): ToolExecutors {
  return {
    async memory(args) {
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

    async session_search(args) {
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

    async provider_memory(args) {
      if (!manager.provider) return JSON.stringify({ success: false, error: `no memory provider active (config provider=${providerName})` });
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

    // skill_list/skill_view are intentionally not registered: opencode itself
    // lists skills in the system prompt and can read SKILL.md/support files with
    // the normal read tool. Curate/restore are folded into skill_manage's action
    // enum (rather than separate tools) to keep the surface at 4 tools.
    async skill_manage(args) {
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
  };
}
