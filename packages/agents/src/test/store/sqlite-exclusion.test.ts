import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../../schema";
import { SqliteSessionStore } from "../../store/sqlite";
import { type ChildScript, startScript } from "../helpers/child-script";
import { libsqlDatabases } from "../helpers/sqlite";

const LOCKED = /locked|busy/i;
const files = libsqlDatabases("file");

function session(id: string, title: string | null = null): SessionRecord {
  return {
    createdAt: 1,
    id,
    parentMessageId: null,
    parentSessionId: null,
    status: "active",
    title,
    updatedAt: 1,
  };
}

describe("a transaction against another connection to its file", () => {
  it("a second client in this process is refused, and lands nothing", async () => {
    const database = await files.open();
    const store = new SqliteSessionStore({ database, scope: "s" });
    const elsewhere = new SqliteSessionStore({
      database: files.connect(database),
      scope: "s",
    });
    await store.commit({ putSessions: [session("a")] });

    const outcome = await store.transaction(async (view) => {
      const refused = await elsewhere
        .commit({ putSessions: [session("a", "outside")] })
        .then(
          () => "landed",
          (error: unknown) => String(error)
        );
      const after = await view.getSession("a");
      await view.commit({ putSessions: [session("a", "inside")] });
      return { after, refused };
    });

    expect(outcome.refused).toContain("SQLITE_BUSY");
    expect(outcome.after).toStrictEqual(session("a"));
    await expect(elsewhere.getSession("a")).resolves.toStrictEqual(
      session("a", "inside")
    );
  });

  it("another process's write is held off, then lands after it commits", async () => {
    const database = files.connect(await files.open(), { busyTimeout: 5000 });
    const store = new SqliteSessionStore({ database, scope: "s" });
    await store.commit({ putSessions: [session("a")] });
    let writer: ChildScript | undefined;

    try {
      const outcome = await store.transaction(async (view) => {
        writer = await startScript(WRITER, [
          pathToFileURL(
            createRequire(import.meta.url).resolve("@libsql/client")
          ).href,
          `file:${files.path(database)}`,
          "outside",
        ]);
        const probe = await writer.line();
        const after = await view.getSession("a");
        await view.commit({ putSessions: [session("a", "inside")] });
        return { after, probe, writer };
      });

      expect(outcome.probe).toMatch(LOCKED);
      expect(outcome.after).toStrictEqual(session("a"));
      expect(await outcome.writer.line()).toBe("written");
      await outcome.writer.exited();
      await expect(store.getSession("a")).resolves.toStrictEqual(
        session("a", "outside")
      );
    } finally {
      await writer?.stop();
    }
  });
});

const WRITER = `const [client, url, title] = process.argv.slice(2);
const { createClient } = await import(client);
const probe = createClient({ url });
try {
  const attempt = await probe.transaction("write");
  await attempt.rollback();
  console.log("free");
} catch (error) {
  console.log(String(error));
} finally {
  probe.close();
}
const db = createClient({ url, timeout: 10000 });
const transaction = await db.transaction("write");
await transaction.execute({
  sql: "UPDATE agent_sessions SET title = ? WHERE scope = 's' AND id = 'a'",
  args: [title],
});
await transaction.commit();
db.close();
console.log("written");
`;
