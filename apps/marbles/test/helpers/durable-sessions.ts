import { sql } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { openWorkspaceDatabase } from "~/database/managed";
import type { StoreDatabase } from "~/database/open";
import { writeDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import type { ListedSessionStore } from "~/lib/usage/evidence";

export function durableSessions(
  state: string,
  scope = "test"
): ListedSessionStore {
  const opened = openWorkspaceDatabase({ state, workspaceId: scope });
  onTestFinished(() => opened.close());
  return opened.sessions;
}

export function transcriptOf(state: string, sessionId: string, scope = "test") {
  const at = sql`scope = ${scope} AND session_id = ${sessionId}`;
  let kept: { id: string; parts: string }[] | undefined;
  const write = (work: (database: StoreDatabase) => Promise<unknown>) =>
    writeDatabase(stateDatabase(state), work);
  return {
    damage: () =>
      write(async (database) => {
        kept ??= await database.all<{ id: string; parts: string }>(
          sql`SELECT id, parts FROM agent_messages WHERE ${at}`
        );
        await database.run(
          sql`UPDATE agent_messages SET parts = '{broken' WHERE ${at}`
        );
      }),
    remove: () =>
      write(async (database) => {
        await database.run(sql`DELETE FROM agent_messages WHERE ${at}`);
        await database.run(
          sql`DELETE FROM agent_sessions WHERE scope = ${scope} AND id = ${sessionId}`
        );
      }),
    restore: () =>
      write(async (database) => {
        for (const { id, parts } of kept ?? []) {
          await database.run(
            sql`UPDATE agent_messages SET parts = ${parts} WHERE scope = ${scope} AND id = ${id}`
          );
        }
        kept = undefined;
      }),
  };
}
