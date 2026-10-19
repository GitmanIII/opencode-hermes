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
// provider, which would register provider_memory and make the surface assertion
// flaky). The fixture keeps `provider: none` but shortens the review cadence so
// the idle trigger can be exercised without a 10s debounce.
const CFG = path.join(TMP, "test-config.json");
await fs.writeFile(CFG, `{ "nudgeInterval": 1, "idleDebounceMs": 25 }\n`, "utf-8");
process.env.HERMES_OPENCODE_CONFIG = CFG;
delete process.env.HERMES_OPENCODE_PROVIDER;

const pluginModule = (await import("../../plugin.ts")).default;
const { isSameLocation } = await import("../../v2.ts");

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
function mockContext(opts: { failSubscribeOnce?: boolean } = {}) {
  const hooks = new Map<string, Any>();
  const tools: Any[] = [];
  const synthetic: string[] = [];
  const generated: string[] = [];
  const messages: Any[] = [{ type: "user", text: "please use 4-space indent" }];

  // Controllable event queue: the plugin's subscriber loop parks on `next()`
  // until a test pushes an event. Without this the idle trigger (the v0.10.1
  // fix — a review that runs when a turn completes) has no hermetic coverage at
  // all, so a broken event name would pass the suite.
  const queued: Any[] = [];
  let waiter: ((result: Any) => void) | null = null;
  let subscribeCalls = 0;
  const events = {
    push(event: Any) {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: event, done: false });
      } else {
        queued.push(event);
      }
    },
  };

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
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
        subscribeCalls++;
        if (opts.failSubscribeOnce && subscribeCalls === 1) throw new Error("event stream dropped");
        return {
          [Symbol.asyncIterator]: () => ({
          next: () => {
            if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
            return new Promise((resolve, reject) => {
              waiter = resolve;
              signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
          },
          }),
        };
      },
    },
  };
  return { ctx, hooks, tools, synthetic, generated, messages, events, subscribeCalls: () => subscribeCalls };
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

// 5. the event subscription drives the idle trigger (the v0.10.1 fix): a turn
//    completion must reach core.onIdle and run the review, and a new session must
//    re-freeze the injected memory snapshot. Both were previously uncovered.
assert("V2 registers 3 session hooks", harness.hooks.size === 3, [...harness.hooks.keys()].join(","));
assert("V2 setup returns a cleanup function", typeof cleanup === "function");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 2000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return true;
    await sleep(10);
  }
  return await cond();
};
const snapshotText = async () => {
  const event: Any = { system: [] as Array<{ type: string; text: string }> };
  await harness.hooks.get("context")(event);
  return (event.system as Array<{ text: string }>).map((p) => p.text).join("\n");
};

// event.location is the session's location, not the plugin instance's. Events
// from another directory must not refresh this instance's snapshot or trigger
// its review with the wrong project id.
const own = {
  directory: "/home/emil/sample-project",
  project: { directory: "/home/emil/sample-project", canonical: "/home/emil/sample-project" },
};
assert("V2 events without a location are accepted", isSameLocation(undefined, own));
assert("V2 events from the same directory are accepted", isSameLocation({ directory: own.directory }, own));
assert("V2 events from another directory are ignored", !isSameLocation({ directory: "/home/emil/other" }, own));
assert("V2 workspace ids take precedence", isSameLocation({ directory: "/elsewhere", workspaceID: "ws1" }, { ...own, workspaceID: "ws1" }));

// session.created → store refresh + snapshot re-freeze: the fact added in
// section 2 is on disk but not in the snapshot frozen at setup.
const frozen = await snapshotText();
assert("V2 snapshot is frozen before a new session", !frozen.includes("v2 harness fact"), frozen.slice(0, 80));
harness.events.push({ type: "session.created", location: { directory: "/home/emil/other" }, data: { sessionID: "ses_other" } });
await sleep(150);
assert("V2 ignores another location's session event", !(await snapshotText()).includes("v2 harness fact"));
harness.events.push({ type: "session.created", data: { sessionID: "ses_v2" } });
assert("V2 session.created refreshes the injected snapshot", await waitFor(async () => (await snapshotText()).includes("v2 harness fact")));

// session.execution.succeeded → core.onIdle → review. The fixture config sets
// nudgeInterval=1 and idleDebounceMs=25, so section 4's single turn suffices.
harness.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses_v2" } });
assert("V2 turn completion runs the review", await waitFor(() => harness.generated.length > 0), `generate.text calls=${harness.generated.length}`);
const logText = await fs.readFile(path.join(TMP, "test.log"), "utf-8");
assert("V2 review is logged", logText.includes("background review:"), logText.split("\n").slice(-3).join(" | "));

if (typeof cleanup === "function") await cleanup();

// 6. A dropped event stream reconnects instead of silently disabling learning.
{
  const retry = mockContext({ failSubscribeOnce: true });
  const retryCleanup = await pluginModule.setup(retry.ctx);
  const retryPrompt = retry.hooks.get("prompt");
  await retryPrompt({ sessionID: "ses_retry", prompt: { text: "hello again" } });
  assert("V2 retries a failed event subscription", await waitFor(() => retry.subscribeCalls() >= 2, 3000), `calls=${retry.subscribeCalls()}`);
  retry.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses_retry" } });
  assert("V2 review still runs after reconnect", await waitFor(() => retry.generated.length > 0, 3000), `generate calls=${retry.generated.length}`);
  if (typeof retryCleanup === "function") await retryCleanup();
}

await fs.rm(TMP, { recursive: true, force: true });
await fs.rm(SKILLS, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
