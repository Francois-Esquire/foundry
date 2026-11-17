import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { ContainerRow } from "../schema";
import { SqliteContainerStore } from "../store/sqlite";
import { type ChildScript, startScript } from "./helpers/child-script";
import { libsqlDatabases } from "./helpers/sqlite";

const LOCKED = /locked|busy/i;
const files = libsqlDatabases("file");

function row(id: string, status: ContainerRow["status"] = "stopped") {
  return {
    createdAt: 1,
    id,
    nativeId: `${id}-1`,
    spec: JSON.stringify({
      format: "foundry.sandbox.container/1",
      image: "docker.io/oven/bun:1",
    }),
    status,
    updatedAt: 1,
  } satisfies ContainerRow;
}

describe("a transaction against another connection to its file", () => {
  it("a second client in this process is refused, and lands nothing", async () => {
    const database = await files.open();
    const store = new SqliteContainerStore({ database, scope: "s" });
    const elsewhere = new SqliteContainerStore({
      database: files.connect(database),
      scope: "s",
    });
    await store.commit({ putContainers: [row("a")] });

    const outcome = await store.transaction(async (view) => {
      const refused = await elsewhere
        .commit({ putContainers: [row("a", "failed")] })
        .then(
          () => "landed",
          (error: unknown) => String(error)
        );
      const after = await view.get("a");
      await view.commit({ putContainers: [row("a", "running")] });
      return { after, refused };
    });

    expect(outcome?.refused).toContain("SQLITE_BUSY");
    expect(outcome?.after).toStrictEqual(row("a"));
    expect(await elsewhere.get("a")).toStrictEqual(row("a", "running"));
  });

  it("another process's write is held off, then lands after it commits", async () => {
    const opened = await files.open();
    const database = files.connect(opened, { busyTimeout: 5000 });
    const store = new SqliteContainerStore({ database, scope: "s" });
    await store.commit({ putContainers: [row("a")] });
    let writer: ChildScript | undefined;

    try {
      const outcome = await store.transaction(async (view) => {
        writer = await startScript(WRITER, [
          pathToFileURL(
            createRequire(import.meta.url).resolve("@libsql/client")
          ).href,
          `file:${files.path(database)}`,
          "failed",
        ]);
        const probe = await writer.line();
        const after = await view.get("a");
        await view.commit({ putContainers: [row("a", "running")] });
        return { after, probe, writer };
      });

      expect(outcome?.probe).toMatch(LOCKED);
      expect(outcome?.after).toStrictEqual(row("a"));
      expect(await outcome?.writer.line()).toBe("written");
      await outcome?.writer.exited();
      expect(await store.get("a")).toStrictEqual(row("a", "failed"));
    } finally {
      await writer?.stop();
    }
  });
});

const WRITER = `const [client, url, status] = process.argv.slice(2);
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
  sql: "UPDATE sandbox_containers SET status = ? WHERE scope = 's' AND id = 'a'",
  args: [status],
});
await transaction.commit();
db.close();
console.log("written");
`;
