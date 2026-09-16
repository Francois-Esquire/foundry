import type { JsonSessionStore } from "~/sessions/json-store";

export async function sessionLines(store: JsonSessionStore): Promise<string[]> {
  const lines: string[] = [];
  for (const session of store.sessions()) {
    const messages = await store.listMessages(session.id);
    const summary = messages.some((m) => m.role === "summary");
    lines.push(
      `${session.id}  ${String(messages.length)} messages  ${new Date(session.updatedAt).toISOString()}  summary: ${summary ? "yes" : "no"}`
    );
  }
  return lines;
}
