/**
 * Hermes Memory for OpenCode — internal-session LLM channel.
 *
 * OpenCode plugins have no direct "text completion" API, so we drive the LLM
 * through a throwaway internal session (like opencode-mem does). Every call
 * creates a session, sends one prompt, collects the assistant text, then
 * deletes the session. Sessions are title-tagged so background-learning logic
 * can skip them (avoids an unbounded idle → LLM → idle loop).
 */
import type { PluginInput } from "@opencode-ai/plugin";

export const INTERNAL_SESSION_TITLE = "[hm-internal]";

/** 本进程创建的内部会话 ID（创建时登记、删除时移除）。
 *  chat.message 等钩子用它同步跳过内部会话，避免审查 prompt 触发
 *  纠正检测/记忆自动注入/轮次计数（标题检查需要异步 session.get，太贵）。 */
const internalSessionIDs = new Set<string>();

export function isInternalSessionId(sessionID: string | undefined | null): boolean {
  return typeof sessionID === "string" && internalSessionIDs.has(sessionID);
}

export function isInternalSession(title: string | undefined | null): boolean {
  return typeof title === "string" && title.startsWith(INTERNAL_SESSION_TITLE);
}

export type InternalCompletion = {
  text: string;
  error?: string;
};

/**
 * Run one LLM completion via a fresh internal session.
 * model may be { providerID, modelID }; omit to inherit the default.
 */
export async function completeWithInternalSession(
  client: PluginInput["client"],
  directory: string,
  systemPrompt: string,
  userPrompt: string,
  model?: { providerID: string; modelID: string },
): Promise<InternalCompletion> {
  let sessionID: string | undefined;
  try {
    const created = await client.session.create({
      query: { directory },
      body: { title: INTERNAL_SESSION_TITLE },
    });
    sessionID = created.data?.id;
    if (!sessionID) return { text: "", error: "Failed to create internal session" };
    internalSessionIDs.add(sessionID);

    const resp = await client.session.prompt({
      path: { id: sessionID },
      body: {
        model,
        parts: [
          { type: "text", text: systemPrompt },
          { type: "text", text: userPrompt },
        ],
      },
    });
    const parts = resp.data?.parts ?? [];
    const text = parts
      .filter((p) => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => (p as { text: string }).text)
      .join("\n");
    return { text: text.trim() };
  } catch (err) {
    return { text: "", error: String(err) };
  } finally {
    if (sessionID) {
      internalSessionIDs.delete(sessionID);
      try {
        await client.session.delete({ path: { id: sessionID } });
      } catch (err) {
        // 删除失败不能静默——记录日志便于发现内部会话堆积
        console.error(`[hermes-memory] internal session delete failed: ${sessionID}`, err);
      }
    }
  }
}
