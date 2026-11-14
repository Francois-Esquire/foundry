import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import type { BlobFiles } from "../blob";
import { ArtifactManager } from "../manager";
import { blobFiles } from "../node";
import { STAGING_ABANDONED_AFTER_MS } from "../node/staging";
import type { ArtifactDatabase } from "../store/sqlite";
import { SqliteArtifactStore } from "../store/sqlite";
import { interceptCommits } from "../testing";
import { required } from "./helpers/required";
import { type LibsqlDatabases, libsqlDatabases } from "./helpers/sqlite";
import { openStore, STORE_KINDS } from "./helpers/stores";

const roots: string[] = [];
afterAll(() =>
  Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })))
);

/** What a host transaction that rolls back throws, and the test expects. */
const ROLLED_BACK = "host rolled back";

/**
 * An Artifact holding `a.txt` ("before") over a file-backed blob root, made
 * by a manager over the plain database, and the means to change it inside
 * a transaction the host owns.
 */
async function setup(databases: LibsqlDatabases) {
  const database = await databases.open();
  const root = await mkdtemp(join(tmpdir(), "artifact-host-"));
  roots.push(root);
  const files = blobFiles(root);
  const durable = new ArtifactManager({
    files,
    store: new SqliteArtifactStore({ database, scope: "s" }),
  });
  const created = await durable.create({
    entries: { "a.txt": { bytes: "before" } },
    name: "A",
    type: "text/plain",
  });
  const published = async () =>
    (await readdir(root)).filter((name) => !name.startsWith(".")).sort();
  const original = await published();
  /** Every published file, dated as if untouched for twice the guard. */
  const age = async () => {
    const then = new Date(Date.now() - 2 * STAGING_ABANDONED_AFTER_MS);
    for (const name of await published()) {
      await utimes(join(root, name), then, then);
    }
  };
  const read = async (manager: ArtifactManager = durable) => {
    const artifact = required(await manager.get(created.id));
    const file = await manager.readFile(required(artifact.contentId), "a.txt");
    return new TextDecoder().decode(required(file).blob);
  };
  const rewrite = (manager: ArtifactManager) =>
    manager.write({
      artifactId: created.id,
      changes: { put: { "a.txt": { bytes: "after" } } },
    });
  /**
   * `work` with a manager over a store on the host's own transaction, which
   * then commits or rolls back.
   */
  const inHost = async (
    outcome: "commit" | "rollback",
    work: (joined: ArtifactManager) => Promise<unknown>,
    joinedFiles: BlobFiles = files
  ) => {
    try {
      await database.transaction(async (transaction) => {
        const joined = new ArtifactManager({
          files: joinedFiles,
          store: new SqliteArtifactStore({ database: transaction, scope: "s" }),
        });
        await work(joined);
        if (outcome === "rollback") {
          throw new Error(ROLLED_BACK);
        }
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === ROLLED_BACK)) {
        throw error;
      }
    }
  };
  return {
    age,
    database,
    durable,
    files,
    inHost,
    original,
    published,
    read,
    rewrite,
    root,
  };
}

describe.each([
  ["memory", libsqlDatabases("memory")],
  ["file", libsqlDatabases("file")],
] as const)(
  "a manager inside a host transaction (%s)",
  (_location, databases) => {
    test("leaves the file a change retired, so a host rollback still reads it", async () => {
      const { inHost, original, published, read, rewrite } =
        await setup(databases);
      await inHost("rollback", async (joined) => {
        await rewrite(joined);
        expect(await read(joined)).toBe("after");
      });

      expect(await read()).toBe("before");
      expect(await published()).toEqual(expect.arrayContaining(original));
    });

    test("keeps a retired file from a recover run through the host's own transaction", async () => {
      const { age, inHost, read, rewrite } = await setup(databases);
      // Old enough to count as abandoned, but for the change retiring it.
      await age();
      await inHost("rollback", async (joined) => {
        await rewrite(joined);
        // Reads the host's uncommitted records, which no longer name it.
        await joined.recover();
      });

      expect(await read()).toBe("before");
    });

    test("leaves a retired file once the host commits, for recover to reclaim when it has aged", async () => {
      const {
        age,
        files,
        inHost,
        original,
        published,
        read,
        rewrite,
        database,
      } = await setup(databases);
      await age();
      await inHost("commit", rewrite);
      expect(await read()).toBe("after");
      // Not removed in line: the manager could not know the host would commit.
      expect(await published()).toEqual(expect.arrayContaining(original));

      const held = new ArtifactManager({
        files,
        store: new SqliteArtifactStore({
          database,
          durability: "host",
          scope: "s",
        }),
      });
      await held.recover();
      // Retired just now, so a host-held recover keeps it ...
      expect(await published()).toEqual(expect.arrayContaining(original));
      await age();
      await held.recover();
      // ... until it has gone unchanged as long as abandoned staging.
      expect(await published()).not.toEqual(expect.arrayContaining(original));
      expect(await published()).toHaveLength(1);
      expect(await read()).toBe("after");
    });

    test("a durable manager's recover reclaims a file a committed host change retired, at once", async () => {
      const { durable, inHost, original, published, read, rewrite } =
        await setup(databases);
      await inHost("commit", rewrite);

      await durable.recover();
      expect(await published()).not.toEqual(expect.arrayContaining(original));
      expect(await published()).toHaveLength(1);
      expect(await read()).toBe("after");
    });

    test("reclaims a file a rolled-back host change published, once it has aged", async () => {
      const { age, database, files, inHost, original, published, rewrite } =
        await setup(databases);
      await inHost("rollback", rewrite);
      expect(await published()).toHaveLength(original.length + 1);

      const held = new ArtifactManager({
        files,
        store: new SqliteArtifactStore({
          database,
          durability: "host",
          scope: "s",
        }),
      });
      await held.recover();
      expect(await published()).toHaveLength(original.length + 1);
      await age();
      await held.recover();
      expect(await published()).toEqual(original);
    });

    test("keeps the retired file through a store wrapped by interceptCommits", async () => {
      const { files, database, original, published, read, rewrite } =
        await setup(databases);
      try {
        await database.transaction(async (transaction) => {
          const joined = new ArtifactManager({
            files,
            store: interceptCommits(
              new SqliteArtifactStore({ database: transaction, scope: "s" }),
              (write, land) => land(write)
            ),
          });
          await rewrite(joined);
          throw new Error(ROLLED_BACK);
        });
      } catch (error) {
        expect(String(error)).toContain(ROLLED_BACK);
      }

      expect(await read()).toBe("before");
      expect(await published()).toEqual(expect.arrayContaining(original));
    });

    test("fails a change whose retirement mark fails, before it commits", async () => {
      const { files, inHost, original, published, read, rewrite } =
        await setup(databases);
      const failing: BlobFiles = {
        abandoned: (path) => required(files.abandoned)(path),
        list: () => files.list(),
        publish: (bytes) => files.publish(bytes),
        read: (path, range) => files.read(path, range),
        remove: (path) => files.remove(path),
        retire: () => Promise.reject(new Error("retire failed")),
      };
      await inHost(
        "commit",
        async (joined) => {
          await expect(rewrite(joined)).rejects.toThrow("retire failed");
        },
        failing
      );

      expect(await read()).toBe("before");
      // The file the change published for "after" went with it.
      expect(await published()).toEqual(original);
    });
  }
);

describe("a store's durability", () => {
  const databases = libsqlDatabases("memory");

  test("is the host's over a Drizzle transaction, and refuses to be called durable there", async () => {
    const database = await databases.open();
    expect(new SqliteArtifactStore({ database, scope: "s" }).durability).toBe(
      "commit"
    );
    expect(
      new SqliteArtifactStore({ database, durability: "host", scope: "s" })
        .durability
    ).toBe("host");
    await database.transaction(async (transaction) => {
      expect(
        new SqliteArtifactStore({ database: transaction, scope: "s" })
          .durability
      ).toBe("host");
      expect(
        () =>
          new SqliteArtifactStore({
            database: transaction,
            durability: "commit",
            scope: "s",
          })
      ).toThrow(RangeError);
      await transaction.transaction(async (nested: ArtifactDatabase) => {
        expect(
          new SqliteArtifactStore({ database: nested, scope: "s" }).durability
        ).toBe("host");
      });
    });
  });

  test("refuses a host-held manager whose BlobFiles cannot mark or age a file", async () => {
    const database = await databases.open();
    const root = await mkdtemp(join(tmpdir(), "artifact-host-files-"));
    roots.push(root);
    const full = blobFiles(root);
    const bare: BlobFiles = {
      list: () => full.list(),
      publish: (bytes) => full.publish(bytes),
      read: (path, range) => full.read(path, range),
      remove: (path) => full.remove(path),
    };
    const store = new SqliteArtifactStore({
      database,
      durability: "host",
      scope: "s",
    });
    expect(() => new ArtifactManager({ files: bare, store })).toThrow(
      "needs BlobFiles with retire and abandoned"
    );
    // Without files, bytes stay inline in the records: nothing to retire.
    expect(() => new ArtifactManager({ store })).not.toThrow();
    // Over a durable store, files need neither.
    expect(
      () =>
        new ArtifactManager({
          files: bare,
          store: new SqliteArtifactStore({ database, scope: "s" }),
        })
    ).not.toThrow();
  });
});

describe.each(STORE_KINDS)(
  "a manager over a %s store's transaction view",
  (kind) => {
    test("leaves the file a change retired when the transaction's work throws", async () => {
      const store = await openStore(kind);
      const root = await mkdtemp(join(tmpdir(), "artifact-view-"));
      roots.push(root);
      const files = blobFiles(root);
      const outer = new ArtifactManager({ files, store });
      const created = await outer.create({
        entries: { "a.txt": { bytes: "before" } },
        name: "A",
        type: "text/plain",
      });
      const transaction = required(store.transaction?.bind(store));

      await expect(
        transaction(async (view) => {
          const inner = new ArtifactManager({ files, store: view });
          await inner.write({
            artifactId: created.id,
            changes: { put: { "a.txt": { bytes: "after" } } },
          });
          throw new Error(ROLLED_BACK);
        })
      ).rejects.toThrow(ROLLED_BACK);

      const artifact = required(await outer.get(created.id));
      const file = await outer.readFile(required(artifact.contentId), "a.txt");
      expect(new TextDecoder().decode(required(file).blob)).toBe("before");
    });
  }
);

describe.each([
  ["memory", libsqlDatabases("memory")],
  ["file", libsqlDatabases("file")],
] as const)(
  "deletes inside a host transaction (%s)",
  (_location, databases) => {
    test("a deleted Artifact's files survive a host rollback", async () => {
      const { durable, inHost, original, published, read } =
        await setup(databases);
      const [only] = (await durable.list({})).items;
      await inHost("rollback", async (joined) => {
        expect(await joined.delete(required(only).id)).toBe(true);
      });

      expect(await read()).toBe("before");
      expect(await published()).toEqual(original);
    });

    test("Content and blobs a sweep removed survive a host rollback", async () => {
      const { durable, inHost, read } = await setup(databases);
      const [only] = (await durable.list({})).items;
      const artifact = required(only);
      const first = required(artifact.content);
      // A second Content holding its own file, then the first selected again:
      // the second is ready, unpointed and unfrozen, so a sweep takes it.
      const second = await durable.revise({
        artifactId: artifact.id,
        changes: { put: { "b.txt": { bytes: "second only" } } },
        contentId: first.id,
        expectedUpdatedAt: first.updatedAt,
      });
      await durable.select({ artifactId: artifact.id, contentId: first.id });
      const readSecond = async () => {
        const file = await durable.readFile(second.id, "b.txt");
        return new TextDecoder().decode(required(file).blob);
      };
      expect(await readSecond()).toBe("second only");

      await inHost("rollback", async (joined) => {
        const swept = await joined.sweep({
          olderThan: new Date(Date.now() + 60_000),
        });
        expect(swept.contents).toBe(1);
        expect(swept.blobs).toBeGreaterThan(0);
      });

      expect(await readSecond()).toBe("second only");
      expect(await read()).toBe("before");
    });
  }
);
