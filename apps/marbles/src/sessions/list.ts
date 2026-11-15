import type { SessionMessage, SessionRecord } from "@foundry/agents/schema";
import type { ListedSessionStore } from "~/lib/usage-evidence";

/** One line per session the store lists, newest first. */
export async function sessionLines(
  store: ListedSessionStore
): Promise<string[]> {
  const sessions: {
    readonly messages: readonly SessionMessage[];
    readonly session: SessionRecord;
  }[] = [];
  for (const { id } of await store.stamps()) {
    const session = await store.getSession(id);
    if (session !== null) {
      sessions.push({ messages: await store.listMessages(id), session });
    }
  }
  sessions.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  return sessions.map(({ messages, session }) => {
    const summary = messages.some((m) => m.role === "summary");
    return `${session.id}  ${String(messages.length)} messages  ${new Date(session.updatedAt).toISOString()}  summary: ${summary ? "yes" : "no"}`;
  });
}
