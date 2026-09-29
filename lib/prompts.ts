/**
 * opencode-hermes — prompts & constants (Hermes core).
 *
 * Faithful to Hermes' built-in memory: two files (MEMORY.md / USER.md),
 * §-delimited entries, hard char caps, injected whole into the system prompt.
 * The background review writes memory (memory|user) and skills.
 */

// ─── Entry delimiter (same as Hermes) ───
export const ENTRY_DELIMITER = "\n§\n";

// ─── Character limits (Hermes tools/memory_tool.py defaults) ───
export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_USER_CHAR_LIMIT = 1375;

// ─── System-prompt block headers (Hermes) ───
export const MEMORY_BLOCK_HEADERS: Record<"memory" | "user", string> = {
  memory: "MEMORY (your personal notes)",
  user: "USER PROFILE (who the user is)",
};
export const BLOCK_SEPARATOR = "═".repeat(46);

// ─── Memory tool description (Hermes MEMORY_SCHEMA) ───
export const MEMORY_TOOL_DESCRIPTION = `Save durable facts to persistent memory that survive across sessions. Memory is injected into every future turn, so keep entries compact and high-signal.

HOW: make ALL your changes in ONE call via an 'operations' array (each item: {action, content?, old_text?}). The batch applies atomically and the char limit is checked only on the FINAL result — so a single call can remove/replace stale entries to free room AND add new ones, even when an add alone would overflow. The response reports current/limit chars and confirms completion; one batch call finishes the update, so don't repeat it. Use the bare action/content/old_text fields only for a single lone change.

WHEN: save proactively when the user states a preference, correction, or personal detail, or you learn a stable fact about their environment, conventions, or workflow. Priority: user preferences & corrections > environment facts > procedures. The best memory stops the user repeating themselves.

IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that removes or shortens enough stale entries and adds the new one together.

TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes (environment, conventions, tool quirks, lessons).

SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, completed-work logs, temporary TODO state. Reusable procedures belong in a skill, not memory.`;

// ─── session_search guidance (Hermes) ───
export const SESSION_SEARCH_GUIDANCE =
  "When the user references something from a past conversation or you suspect relevant cross-session context exists, use session_search to recall it before asking them to repeat themselves.";

export const SESSION_SEARCH_TOOL_DESCRIPTION = `Recall past OpenCode conversations: search or read old sessions, or scroll inside one. Four shapes, picked by args: \`query\` = discovery (top matching sessions, top result hydrated); \`session_id\` + \`around_message_id\` = scroll (window of messages around an anchor); \`session_id\` alone = read a whole session; no args = browse recent sessions. Results are actual stored messages, no LLM. Searches conversation history ONLY — when the user gave a direct source (URL, file, live system), inspect that first; never conclude "not found" from history alone. Use for questions about past conversations: "what did we do about X", "where did we leave Y".`;

// ─── Review / flush system prompts ───
export const MEMORY_OPERATIONS_SCHEMA = `Respond with JSON only (no markdown fences):
{
  "operations": [
    { "action": "add", "target": "memory", "content": "entry text" }
  ]
}

Operation fields:
- action: "add" | "replace" | "remove"
- target: "memory" | "user"
- content: required for add/replace
- old_text: required for replace/remove (substring match)`;

export const SKILLS_OPERATIONS_SCHEMA = `Also return a "skills" array for procedural-memory updates (omit it, or leave it empty, if none):
{
  "skills": [
    {
      "action": "create",
      "name": "class-level-name",
      "category": "software-development",
      "content": "---\\nname: class-level-name\\ndescription: One sentence under sixty chars.\\n---\\n\\n# Title\\n\\n..."
    }
  ]
}

Skill operation fields:
- action: "create" | "patch" | "edit" | "delete" | "write_file" | "remove_file"
- name: lowercase-hyphen, ≤64 chars
- category: optional category folder (create only)
- content: full SKILL.md for create/edit. MUST start with --- frontmatter containing name and description, and have a non-empty body.
- old_string / new_string: for patch (substring match in SKILL.md); replace_all optional
- file_path / file_content: for write_file (path must be under references/, scripts/, templates/, or assets/)

Skill authoring standards:
- description: ONE sentence, ≤60 characters, ends with a period, states the capability and its trigger. No marketing words.
- body section order: "# Title", then "## When to Use", "## Prerequisites", "## How to Run", "## Quick Reference", "## Procedure", "## Pitfalls", "## Verification" (omit a section only if it is genuinely empty).
- Prefer exact commands, paths, and config keys that appeared VERBATIM in the session. Never invent flags or APIs.
- Prefer CLASS-LEVEL skills. Session-specific detail belongs in references/ support files, not new narrow skills.`;

export const DIRECT_REVIEW_SYSTEM_PROMPT = `You review coding conversations and do two things: save durable memory, and keep the skill library current.

Memory — focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering? Save to target "user".
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate? Save to target "user".
3. Durable environment facts, conventions, and tool quirks. Save to target "memory".

Skills (procedural memory) — how to do this class of task. Be ACTIVE: most sessions produce at least one skill update, even if small. Preference order: (1) update a skill that was used this session, (2) update an existing umbrella skill, (3) add a support file under an existing skill, (4) create a new CLASS-LEVEL skill only when no existing skill covers the class. Never create one-session narrow skills.

WRITE CONCISELY: each memory entry must be ≤300 characters. Prefer dense bullets over prose.

${MEMORY_OPERATIONS_SCHEMA}

${SKILLS_OPERATIONS_SCHEMA}

If nothing is worth saving, return {"operations":[],"skills":[]}.`;

export const DIRECT_FLUSH_SYSTEM_PROMPT = `The session is being compressed and about to lose context. Save anything worth remembering from the conversation — prioritize user preferences and corrections over task-specific details.

WRITE CONCISELY: each memory entry must be ≤300 characters.

${MEMORY_OPERATIONS_SCHEMA}

${SKILLS_OPERATIONS_SCHEMA}

If nothing is worth saving, return {"operations":[],"skills":[]}.`;

export const REVIEW_USER_PROMPT = `Review the conversation transcript above and decide what is worth saving.

Consider:
1. User persona, preferences, work style, personal details — save to target "user".
2. Corrections, durable environment facts, conventions, tool quirks — save to target "memory".
3. Procedural knowledge — a reusable workflow, or a skill that turned out stale/incomplete. Update or create a skill in the "skills" array (prefer patching an existing skill).

Skip: task progress, session outcomes, one-off explanations, anything unlikely to matter in a future session.
Do NOT save facts already covered by the <existing-memory> list below (if present).
Do NOT duplicate an existing skill (listed below) — patch it instead.

Return the operations JSON.`;
