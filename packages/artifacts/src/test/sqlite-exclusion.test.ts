import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

import { ArtifactManager } from "../manager";
import { blobFiles } from "../node";
import type { ArtifactId } from "../ref";
import type { Artifact } from "../schema";
import { SqliteArtifactStore } from "../store/sqlite";
import { type ChildScript, startScript } from "./helpers/child-script";
import { required } from "./helpers/required";
import { libsqlDatabases } from "./helpers/sqlite";
import { execInAnotherProcess } from "./helpers/sqlite-process";

/** What SQLite says when a lock it needs is held. */
const LOCKED = /locked|busy/i;
const AT = new Date("2026-01-01T00:00:00.000Z");
const files = libsqlDatabases("file");
const roots: string[] = [];
afterAll(() =>
  Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })))
);

function artifact(id: string, name = id): Artifact {
  return {
    archivedAt: null,
    contentId: null,
    createdAt: AT,
    id: id as ArtifactId,
    metadata: {},
    name,
    publishedAt: null,
    status: "draft",
    type: "text/plain",
    updatedAt: AT,
  };
}

/** Another process's row for Artifact `id`, as SQL values. */
function insertArtifact(id: string): string {
  const at = AT.getTime();
  const order = [...id]
    .map((unit) => unit.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
  return `INSERT INTO artifacts (archived_at, content_id, created_at, id, id_lower, id_order, metadata, name, name_lower, published_at, scope, status, type, type_lower, updated_at)
    VALUES (NULL, NULL, ${at}, '${id}', '${id}', x'${order}', '{}', '${id}', '${id}', NULL, 's', 'draft', 'text/plain', 'text/plain', ${at})`;
}

describe("a listing against another process", () => {
  test("is one state: a commit cannot land between its count and its page", async () => {
    const database = await files.open();
    let attempted: string | undefined;
    const reader = files.connect(database, {
      onQuery: (query) => {
        // Just before the page, another process adds an Artifact.
        if (
          attempted === undefined &&
          query.startsWith('select "archived_at"')
        ) {
          attempted = execInAnotherProcess(files.path(database), [
            insertArtifact("b"),
          ]);
        }
      },
    });
    await new SqliteArtifactStore({ database, scope: "s" }).commit({
      putArtifacts: [artifact("a")],
    });

    const listing = await new SqliteArtifactStore({
      database: reader,
      scope: "s",
    }).listArtifacts({ limit: 10 });

    expect(attempted).toMatch(LOCKED);
    expect(listing).toEqual({ artifacts: [artifact("a")], total: 1 });
  });
});

describe("a transaction against another connection to its file", () => {
  test("a second client in this process is refused, and lands nothing", async () => {
    const database = await files.open();
    const store = new SqliteArtifactStore({ database, scope: "s" });
    const elsewhere = new SqliteArtifactStore({
      database: files.connect(database),
      scope: "s",
    });
    await store.commit({ putArtifacts: [artifact("a")] });

    const outcome = await store.transaction(async (view) => {
      const refused = await elsewhere
        .commit({ putArtifacts: [artifact("a", "outside")] })
        .then(
          () => "landed",
          (error: unknown) => String(error)
        );
      const after = await view.getArtifact(artifact("a").id);
      await view.commit({ putArtifacts: [artifact("a", "inside")] });
      return { after, refused };
    });

    expect(outcome.refused).toContain("SQLITE_BUSY");
    expect(outcome.after).toEqual(artifact("a"));
    expect(await elsewhere.getArtifact(artifact("a").id)).toEqual(
      artifact("a", "inside")
    );
  });

  test("another process's write is held off, then lands after it commits", async () => {
    // A busy timeout, as a host sets one: the other process holds a shared
    // lock now and then while it waits for the write lock.
    const database = files.connect(await files.open(), { busyTimeout: 5000 });
    const store = new SqliteArtifactStore({ database, scope: "s" });
    await store.commit({ putArtifacts: [artifact("a")] });
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
        const after = await view.getArtifact(artifact("a").id);
        await view.commit({ putArtifacts: [artifact("a", "inside")] });
        return { after, probe, writer };
      });

      expect(outcome.probe).toMatch(LOCKED);
      expect(outcome.after).toEqual(artifact("a"));
      expect(await outcome.writer.line()).toBe("written");
      await outcome.writer.exited();
      expect((await store.getArtifact(artifact("a").id))?.name).toBe("outside");
    } finally {
      await writer?.stop();
    }
  });
});

describe("a streamed change over SQLite", () => {
  test("holds no lock while its bytes arrive, between its check and its change", async () => {
    const database = await files.open();
    const root = await mkdtemp(join(tmpdir(), "artifact-sqlite-stream-"));
    roots.push(root);
    const artifacts = new ArtifactManager({
      files: blobFiles(join(root, "blobs")),
      store: new SqliteArtifactStore({ database, scope: "s" }),
    });
    const arriving = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    async function* source() {
      yield new TextEncoder().encode("first ");
      arriving.resolve();
      await proceed.promise;
      yield new TextEncoder().encode("last");
    }

    const created = artifacts.create({
      entries: { "a.txt": { source: source() } },
      name: "Streamed",
      type: "text/plain",
    });
    await arriving.promise;
    // The check has run and released the write lock; the change has not begun.
    const meanwhile = execInAnotherProcess(files.path(database), [
      insertArtifact("other"),
    ]);
    proceed.resolve();
    const streamed = await created;

    expect(meanwhile).toBe("committed");
    const entry = await artifacts.readRoot(required(streamed.content).id);
    expect(new TextDecoder().decode(entry?.blob)).toBe("first last");
    expect((await artifacts.list({})).total).toBe(2);
  });
});

/**
 * Another process's writer on an Artifact file: it tries the write lock
 * once with no busy timeout and prints `free` or the error, then takes it
 * with a busy timeout, renames Artifact `a`, and prints `written`.
 */
const WRITER = `const [client, url, name] = process.argv.slice(2);
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
  sql: "UPDATE artifacts SET name = ?, name_lower = lower(?) WHERE scope = 's' AND id = 'a'",
  args: [name, name],
});
await transaction.commit();
db.close();
console.log("written");
`;
