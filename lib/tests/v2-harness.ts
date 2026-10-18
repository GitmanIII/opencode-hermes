/**
 * opencode-hermes — V2 plugin wiring harness (hermetic, no LLM).
 *
 * Mirrors plugin-harness.ts, but drives the V2 entrypoint with a mock plugin
 * context: `session.hook("context")` injection, `tool.transform` registration,
 * the prompt hook, and the event subscription.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setMemoryRoot, setSkillsRoot } from "../paths.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "fixtures", "sample-memory");

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-v2-"));
const SKILLS = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-v2-skills-"));
await fs.cp(FIXTURES, TMP, { recursive: true });
setMemoryRoot(TMP);
setSkillsRoot(SKILLS);
process.env.HERMES_OPENCODE_LOG = path.join(TMP, "test.log");
// Hermetic: never read the user's real config (it selects the embeddings
// provider, which would register provider_memory and make the surface assertion flaky).
process.env.HERMES_OPENCODE_CONFIG = path.join(TMP, "no-such-config.json");
delete process.env.HERMES_OPENCODE_PROVIDER;

const pluginModule = (await import("../../plugin.ts")).default;

let passed = 0;
let failed = 0;
const assert = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    failed++;
    console.log(`❌ ${name} ${detail}`);
  }
};

type Any = any;

/** Minimal V2 plugin context: records hooks/tools and answers the calls the core makes. */
function mockContext() {
  const hooks = new Map<string, Any>();
  const tools: Any[] = [];
  const synthetic: string[] = [];
  const generated: string[] = [];
  const messages: Any[] = [{ type: "user", text: "please use 4-space indent" }];

  const ctx: Any = {
    app: { name: "opencode", version: "2.0.32", channel: "latest" },
    location: { directory: "/home/emil/sample-project", project: { id: "sample-project", directory: "/home/emil/sample-project", canonical: "/home/emil/sample-project" } },
    options: {},
    session: {
      hook: async (name: string, cb: Any) => {
        hooks.set(name, cb);
        return { dispose: async () => {} };
      },
      context: async () => messages,
      get: async () => ({ id: "ses_v2", title: "v2 harness" }),
      synthetic: async (input: { sessionID: string; text: string }) => {
        synthetic.push(input.text);
        return {};
      },
    },
    generate: {
      text: async (input: { prompt: string }) => {
        generated.push(input.prompt);
        return { text: '{"operations":[],"skills":[]}' };
      },
    },
    tool: {
      transform: async (cb: Any) => {
        cb({
          add: (tool: Any) => tools.push(tool),
          update: () => {},
          remove: () => {},
          list: () => tools,
          get: (id: string) => tools.find((t) => t.name === id),
          namespace: () => {},
        });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise((_r, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }) }),
      }),
    },
  };
  return { ctx, hooks, tools, synthetic, generated, messages };
}

const harness = mockContext();
const cleanup = await pluginModule.setup(harness.ctx);
const toolCtx = { signal: new AbortController().signal, progress: async () => {} };
const findTool = (name: string) => harness.tools.find((t) => t.name === name);

// 1. whole-file memory injection through the V2 `context` hook
const contextHook = harness.hooks.get("context");
assert("V2 registers a context hook", typeof contextHook === "function");
const hookEvent: Any = { system: [] as Array<{ type: string; text: string }> };
await contextHook(hookEvent);
const sys = (hookEvent.system as Array<{ type: string; text: string }>).map((p) => p.text).join("\n");
assert("V2 system prompt includes MEMORY block", sys.includes("MEMORY (your personal notes)") && sys.includes("pnpm build"), sys.slice(0, 120));
assert("V2 system prompt includes USER block", sys.includes("USER PROFILE (who the user is)"));
assert("V2 system prompt includes memory guidance", sys.includes("persistent memory across sessions"));

// 2. tools registered through the V2 transform, with JSON Schema input
assert("V2 registers 3 tools without a provider", harness.tools.length === 3 && !findTool("provider_memory"), harness.tools.map((t) => t.name).join(","));
const memoryTool = findTool("memory");
assert("V2 tools carry a JSON Schema object input", memoryTool?.input?.type === "object" && Boolean(memoryTool.input.properties));

const addRes = JSON.parse(String((await memoryTool.execute({ target: "memory", action: "add", content: "v2 harness fact" }, toolCtx)).content));
assert("V2 memory add succeeds", addRes.success === true, JSON.stringify(addRes));
assert("V2 memory add persisted", (await fs.readFile(path.join(TMP, "MEMORY.md"), "utf-8")).includes("v2 harness fact"));
const batchRes = JSON.parse(String((await findTool("memory").execute({ target: "user", operations: [{ action: "add", content: "v2 user pref" }] }, toolCtx)).content));
assert("V2 memory batch succeeds", batchRes.success === true, JSON.stringify(batchRes));
assert("V2 batch persisted to USER.md", (await fs.readFile(path.join(TMP, "USER.md"), "utf-8")).includes("v2 user pref"));

// 3. skill tool
const skillContent = "---\nname: v2-skill\ndescription: V2-created skill.\n---\n\n# V2 Skill\n\nBody.\n";
const created = JSON.parse(String((await findTool("skill_manage").execute({ action: "create", name: "v2-skill", category: "testing", content: skillContent }, toolCtx)).content));
assert("V2 skill_manage create succeeds", created.success === true, JSON.stringify(created));
const noName = JSON.parse(String((await findTool("skill_manage").execute({ action: "patch", old_string: "x", new_string: "y" }, toolCtx)).content));
assert("V2 skill_manage requires name", noName.success === false && String(noName.error).includes("name is required"), JSON.stringify(noName));

// 4. prompt hook counts turns without a provider injecting notes
const promptHook = harness.hooks.get("prompt");
assert("V2 registers a prompt hook", typeof promptHook === "function");
await promptHook({ sessionID: "ses_v2", prompt: { text: "hello" } });
assert("V2 prompt hook makes no synthetic injection without a provider", harness.synthetic.length === 0, JSON.stringify(harness.synthetic));

// 5. event subscription + cleanup
assert("V2 registers an idle handler via events", harness.hooks.size === 3, [...harness.hooks.keys()].join(","));
assert("V2 setup returns a cleanup function", typeof cleanup === "function");

await fs.rm(TMP, { recursive: true, force: true });
await fs.rm(SKILLS, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
