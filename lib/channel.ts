/**
 * opencode-hermes — host channel.
 *
 * The learning loop (review / flush / dream) needs only a few things from the
 * host, but V1 exposes them through `PluginInput["client"]` while V2 exposes
 * them on the plugin context. Each entrypoint builds a `ReviewChannel` from its
 * own API so `lib/learn.ts` stays host-agnostic and testable.
 */

/** One transcript entry, reduced to the fields the review prompt uses. */
export type TranscriptMessage = {
  role: "user" | "assistant";
  /** Non-synthetic text parts joined with newlines ("" when there are none). */
  text: string;
  /** Assistant model id, rendered in the transcript for provenance. */
  modelID?: string;
  /** Compaction summaries are skipped by the transcript builder. */
  summary?: boolean;
};

export type ChannelCompletion = { text: string; error?: string };

export interface ReviewChannel {
  /** Every message of a session, oldest first (review cursors index into this). */
  transcript(sessionID: string): Promise<TranscriptMessage[]>;
  /**
   * One-shot completion with no tools and no durable session history.
   * `sessionID` is advisory: it lets a host reuse that session's model instead of
   * a global default (V2 `generate.text` otherwise picks the configured default,
   * which may be an unrelated free-tier model).
   */
  complete(system: string, user: string, sessionID?: string): Promise<ChannelCompletion>;
  /** Session title, used to skip hermes' own internal review sessions. */
  sessionTitle(sessionID: string): Promise<string | undefined>;
  /** Inject a note into a session without requesting a reply. */
  injectNote(sessionID: string, text: string): Promise<void>;
  /** Best-effort user notification. */
  toast(message: string): Promise<void>;
}
