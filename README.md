# opencode-hermes

A faithful, local port of [Hermes](https://github.com/weaigc/hermes)' built-in memory to [OpenCode](https://opencode.ai) — plus skill authoring. Two Markdown files, injected whole, a single `memory` tool, and a self-learning review. No vector database, no external service.

## Design (Hermes core)

- **Two files, injected whole** — `MEMORY.md` (your notes) and `USER.md` (the user profile) are rendered into the system prompt every session, with Hermes' headers and a per-session frozen snapshot. No retrieval.
- **Hard char caps** — `MEMORY.md` 2200, `USER.md` 1375 (Hermes defaults), configurable.
- **One `memory` tool** — `target: memory|user`, `action: add|replace|remove|demote`, plus an atomic batch (`operations[]`). Adds are idempotent; the budget is checked only on the final batch result, and an over-budget write returns a *consolidate-and-retry* error rather than silently dropping anything.
- **Self-learning review** — after N turns, on session idle, a review pass reads the conversation and writes memory **and** skills. When the capped files are full it frees room itself (demote/shorten stale entries in the same batch, with one retry), so a full store never silently swallows new facts.
- **Session recall** — `session_search` reads OpenCode's own session database (read-only) to find and read past conversations (discovery / read / scroll / browse; actual messages, no LLM). Discovery matches message text only (never JSON metadata like `"type":"text"`), any term, ranked by terms hit. A system-prompt nudge tells the model to use it when the user references the past. Both storage layouts are supported (OpenCode 1 `session`/`message`/`part`, OpenCode 2 `session_v2`/`session_message`), detected per database.
- **External memory provider (optional, one)** — `provider: "sqlite"` adds an unbounded local note store with **automatic prefetch** (relevant notes injected before each turn). It mirrors built-in writes: `add`/`replace` store the current fact (a replace deletes the superseded one), `remove` propagates the deletion, and `demote` evicts a fact from the capped file while keeping it recallable. Off by default (Hermes ships built-in-only).
- **Skills (procedural memory)** — one `skill_manage` tool: authoring actions `create`/`patch`/`edit`/`delete`/`write_file`/`remove_file`, plus lifecycle actions `curate` (mark agent-created skills stale, archive very old ones; never touches user/pinned skills) and `restore`. Validation and guards: support files may only be written/removed under `references/`/`scripts/`/`templates/`/`assets/` (never `SKILL.md`), path traversal is rejected, `restore` matches the exact archived name, and the autonomous review may only edit agent-created skills. opencode itself lists skills in the system prompt and its read tool opens SKILL.md/support files, so no separate list/view tools.
- **Dream (idle reconciliation)** — when a provider is active, an idle pass compares its store against the current `MEMORY.md`/`USER.md` and **tombstones** notes made obsolete by a canonical fact (they stop being recalled, then are garbage-collected); an optional model judge resolves ambiguous near-duplicates. `dream` on by default, `dreamJudge` off.
- **Robust writes** — atomic temp+rename with SHA-256 fingerprint conflict detection and retry (safe for multiple concurrent OpenCode processes).
- **Observable failures** — provider errors (e.g. a dead embeddings endpoint) and a malformed config file are logged (throttled) instead of silently disabling recall or falling back to defaults.

## Requirements

- OpenCode >= 2.0 (V2 plugin API) or >= 1.18 (V1 plugin API) — one entrypoint serves both
- Bun (for local plugin loading and tests)

## Install

```bash
git clone https://github.com/GitmanIII/opencode-hermes.git ~/opencode-hermes
cd ~/opencode-hermes
bun install
```

Add the plugin directory to `~/.config/opencode/opencode.jsonc` (OpenCode 2):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///home/you/opencode-hermes"]
}
```

OpenCode 2 resolves a configured plugin path as a **directory** (its `package.json` entry), so point at the clone itself, not at a single file. On OpenCode 1 the same default export works through the V1 `plugin`/file form:

```jsonc
{
  "plugin": ["file:///home/you/opencode-hermes/plugin.ts"]
}
```

Restart OpenCode. The memory store is created on first run.

## Configuration

Precedence: **environment variables > config file > defaults**. Defaults match Hermes.

| Variable | Default | Purpose |
|---|---|---|
| `HERMES_OPENCODE_MEMORY_ROOT` | `~/.config/opencode/memories` | memory store root (`MEMORY.md`, `USER.md`) |
| `HERMES_OPENCODE_SKILLS_ROOT` | `~/.agents/skills` | skills root (scanned by OpenCode) |
| `HERMES_OPENCODE_MEMORY_LIMIT` | `2200` | `MEMORY.md` char limit |
| `HERMES_OPENCODE_USER_LIMIT` | `1375` | `USER.md` char limit |
| `HERMES_NUDGE_INTERVAL` | `10` | turns between background reviews |
| `HERMES_IDLE_DEBOUNCE_MS` | `10000` | quiet period after the last turn before the review runs |
| `HERMES_OPENCODE_LOG` | `~/.local/share/opencode/log/opencode-hermes.log` | log file |
| `HERMES_OPENCODE_SESSIONS_DB` | `~/.local/share/opencode/opencode.db` | session DB for `session_search` (read-only) |
| `HERMES_OPENCODE_PROVIDER` | `none` | external long-term memory provider: `none` \| `sqlite` |
| `HERMES_OPENCODE_PROVIDER_PATH` | `<memory root>/provider.sqlite` | provider store path |
| `HERMES_OPENCODE_PREFETCH_LIMIT` | `5` | provider notes injected per turn |
| `HERMES_OPENCODE_DREAM` | `true` | idle reconciliation of the provider store against canonical memory |
| `HERMES_OPENCODE_DREAM_JUDGE` | `false` | let the dream ask the model about ambiguous near-duplicates |
| `HERMES_OPENCODE_CONFIG` | `~/.config/opencode/opencode-hermes.json` | config file path |

Or put the same keys in `~/.config/opencode/opencode-hermes.json` (JSON or JSONC):

```jsonc
{
  "memoryCharLimit": 2200,
  "userCharLimit": 1375,
  "nudgeInterval": 10
}
```

## Tools

`memory` · `session_search` · `skill_manage` · `provider_memory` — 4 tools (3 with no provider active; `provider_memory` is registered only when a provider is configured)

## Architecture

OpenCode 1 and 2 have different, incompatible plugin APIs, so the plugin is split into a host-agnostic core and two thin adapters — one default export serves both:

- `lib/core.ts` — store/provider lifecycle, the frozen system-prompt snapshot, turn counting, and the idle/flush/dream triggers. Host-agnostic.
- `lib/channel.ts` + `lib/llm.ts` — the small host surface the learning loop needs (`transcript`, `complete`, `sessionTitle`, `injectNote`, `toast`) and its V1 implementation (throwaway internal session).
- `lib/tool-specs.ts` — each tool declared once as data, rendered to zod (V1) or JSON Schema (V2), with shared executors.
- `index.ts` — V1 adapter: `experimental.chat.system.transform`, `chat.message`, `event`, `experimental.session.compacting`, `tool()`.
- `v2.ts` — V2 adapter: `session.hook("context"|"prompt"|"compaction")`, `event.subscribe()`, `tool.transform()`, and `generate.text()` for completions (so V2 needs no internal sessions).

Two V2 details worth knowing, both verified against 2.0.32:

- **The idle trigger.** V2's transient `session.idle` event never reaches plugin subscribers (the server writes an `idle` message row and emits `session.execution.succeeded`, but no `session.idle`/`session.status`), so the review/dream trigger on the durable `session.execution.{succeeded,failed,interrupted}` events — the same moment V1's `session.idle` fired.
- **The review's model.** `generate.text` without a model uses the *global default*, which may be an unrelated free-tier model that rejects the request; completions therefore pin the reviewed session's own model (`session.get().model`).

`index.ts` default-exports `{ ...v2, server }`: V2 reads `id` + `setup`, V1 calls `server()`. `plugin.ts` re-exports it for file-based configs.

## How it works

- Entries are `§`-delimited (same as Hermes). There is no per-entry metadata.
- At session start the two files are rendered into the system prompt (frozen for the session; refreshed when a new session starts).
- Every N user turns, on idle, a review pass builds a transcript, asks the model for JSON `{ operations, skills }`, and applies them (memory as atomic per-target batches, skills with the agent guard).
- Before compaction, a shorter flush review saves what matters.
- `session_search` is model-invoked (not automatic): the guidance + tool description tell it to recall past sessions when relevant, then it returns stored messages from the session DB.
- The optional **provider** is automatic: after each user message it prefetches relevant notes and injects them; `provider_memory` adds/searches notes. One provider at a time; implement `MemoryProvider` (`lib/memory-provider.ts`) for a different backend (e.g. embeddings).

## External memory providers

`provider` accepts a **module spec**, not just the built-ins (`none`, `sqlite`):

- a `file://` URL / path to a module exporting `createProvider(options)` or a default factory, or
- an npm package name.

Provider options go under `providerOptions`; `initialize()` receives `{ memoryRoot, providerPath, prefetchLimit, options, projectId, log, warn }`. `log`/`warn` are the host's sinks — config JSON can't carry functions, so a provider that wants its diagnostics in `opencode-hermes.log` (rather than `console`) should use them. One provider at a time. It's used for **automatic prefetch** (before each user message), **mirrors built-in memory writes** from both the `memory` tool and the background/flush review (`add`/`replace`/`remove`/`demote` — removals propagate, evictions stay recallable), and backs the `provider_memory` tool. Providers that scope notes can implement `setProject(id)`.

**Companion:** [**opencode-hermes-embeddings**](https://github.com/GitmanIII/opencode-hermes-embeddings) — semantic recall on your own GPU via HuggingFace **text-embeddings-inference** (`nomic-embed-text-v1.5`, 768-dim), project-scoped.

**Versioning:** this repo and the companion share **one version number**. They are a pair — the host and its optional provider — so a release of either bumps both, and the same number always means a tested pair. The current pair is **opencode-hermes v0.10.4 + opencode-hermes-embeddings v0.10.4**. The core exposes the host `log`/`warn` sinks from v0.10.3, which embeddings v0.9.3+ uses; on an older core the provider falls back to `console`.

```jsonc
{
  "provider": "file:///home/you/opencode-hermes-embeddings/src/provider.ts",
  "providerOptions": {
    "endpoint": "http://127.0.0.1:8080",
    "model": "nomic-ai/nomic-embed-text-v1.5",
    "topK": 5,
    "minScore": 0.58
  }
}
```

## Testing

```bash
bun run test        # 226 hermetic checks (no model, no network)
bun run e2e:idle    # live end-to-end of the V2 idle path (needs a model + TEI)
#   E2E_KEEP=1         keep the clean room for inspection
#   E2E_FULL_MEMORY=1  seed the char cap full: proves the review frees room itself
#   E2E_MODEL=…        give the clean-room session a model (needed when the global
#                      default is a free-tier model, which the server refuses)
```

`scripts/e2e-idle.py` is the live counterpart of the hermetic idle-trigger check: the suite proves a `session.execution.*` event reaches `core.onIdle` and runs the review against a mock host, while the script proves a **live server** actually emits those events and the review runs end to end. It drives a clean-room `opencode acp` instance (`HERMES_OPENCODE_MEMORY_ROOT` etc. redirected, so your real memory is untouched), asserts `background review: memory=…` with no error and the dream line, and exits non-zero otherwise. It sets `HERMES_IDLE_DEBOUNCE_MS` low so it needn't wait the default 10 seconds.

**Note:** a bare ACP `session/new` has **no model**, so the plugin's pin (which reads the reviewed session's model) resolves to nothing and `generate.text` falls back to the global default. If that default is a free-tier model the server rejects it (`Generate.UnavailableError`), so pass `E2E_MODEL` — otherwise the script fails with that reason printed.

226 hermetic checks (no model, no network): store semantics (incl. concurrent-write serialization and cross-process refresh), injection, plugin wiring (V1 hooks and the V2 context/hooks/tools), the V2 idle trigger (turn-completion event → review, and `session.created` re-freezing the snapshot), the 4-tool surface, self-learning, review consolidation on a full store, skills (incl. remove_file/restore guards), efficacy, token cost, curation, JSONC config parsing + warnings, session recall on both DB layouts (multi-term discovery, metadata-token filtering), dream GC.

## Attribution & License

MIT. The memory core is derived from [opencode-hermes-memory](https://github.com/realchendahuang/opencode-hermes-memory) (© 2026 realchendahuang, MIT), itself a port of the Hermes memory system. The skills subsystem, review integration, curation, and fixes are original to this project (GitmanIII). See [LICENSE](LICENSE).
