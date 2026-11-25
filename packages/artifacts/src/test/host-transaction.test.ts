import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";

import { Artifacts } from "../artifacts";
import { blobFiles } from "../node";
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

const ROLLED_BACK = "host rolled back";
const REFUSED_RECOVER = "cannot recover over a store whose commits a host";
const HELD = /SQLITE_BUSY|locked|TRANSACTION_ACTIVE|single connection/i;

const fileDatabases = libsqlDatabases("file");
const memoryDatabases = libsqlDatabases("memory");

async function publishedIn(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => !name.startsWith(".")).sort();
}

async function setup(databases: LibsqlDatabases) {
  const database = await databases.open();
  const root = await mkdtemp(join(tmpdir(), "artifact-host-"));
  roots.push(root);
  const files = blobFiles(root);
  const durable = new Artifacts({
    files,
    store: new SqliteArtifactStore({ database, scope: "s" }),
  });
  const created = await durable.create({
    entries: { "a.txt": { bytes: "before" } },
    name: "A",
    type: "text/plain",
  });
  const published = () => publishedIn(root);
  const original = await published();
  const read = async (manager: Artifacts = durable) => {
    const artifact = required(await manager.get(created.id));
    const file = await manager.readFile(required(artifact.contentId), "a.txt");
    return new TextDecoder().decode(required(file).blob);
  };
  const rewrite = (manager: Artifacts) =>
    manager.write({
      artifactId: created.id,
      changes: { put: { "a.txt": { bytes: "after" } } },
    });
  const inHost = async (
    outcome: "commit" | "rollback",
    work: (joined: Artifacts) => Promise<unknown>
  ) => {
    try {
      await database.transaction(async (transaction) => {
        const joined = new Artifacts({
          files,
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
    database,
    durable,
    files,
    inHost,
    original,
    published,
    read,
    rewrite,
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

    test("refuses recover, however long ago its files changed, so a rollback still reads the original", async () => {
      const { inHost, original, published, read, rewrite } =
        await setup(databases);
      await inHost("rollback", async (joined) => {
        await rewrite(joined);
        const now = Date.now();
        const clock = vi
          .spyOn(Date, "now")
          .mockReturnValue(now + 25 * 60 * 60 * 1000);
        try {
          await expect(joined.recover()).rejects.toThrow(REFUSED_RECOVER);
        } finally {
          clock.mockRestore();
        }
      });

      expect(await read()).toBe("before");
      expect(await published()).toEqual(expect.arrayContaining(original));
    });

    test("after a host commit, a durable recover reclaims the file the change retired", async () => {
      const { durable, inHost, original, published, read, rewrite } =
        await setup(databases);
      await inHost("commit", rewrite);
      expect(await published()).toEqual(expect.arrayContaining(original));

      await durable.recover();
      expect(await published()).not.toEqual(expect.arrayContaining(original));
      expect(await published()).toHaveLength(1);
      expect(await read()).toBe("after");
    });

    test("after a host rollback, a durable recover reclaims what the change published and keeps the original", async () => {
      const { durable, inHost, original, published, read, rewrite } =
        await setup(databases);
      await inHost("rollback", rewrite);
      expect(await published()).toHaveLength(original.length + 1);

      await durable.recover();
      expect(await published()).toEqual(original);
      expect(await read()).toBe("before");
    });

    test("keeps the retired file through a store wrapped by interceptCommits", async () => {
      const { files, database, original, published, read, rewrite } =
        await setup(databases);
      try {
        await database.transaction(async (transaction) => {
          const joined = new Artifacts({
            files,
            store: interceptCommits(
              new SqliteArtifactStore({ database: transaction, scope: "s" }),
              (write, land) => land(write)
            ),
          });
          await expect(joined.recover()).rejects.toThrow(REFUSED_RECOVER);
          await rewrite(joined);
          throw new Error(ROLLED_BACK);
        });
      } catch (error) {
        expect(String(error)).toContain(ROLLED_BACK);
      }

      expect(await read()).toBe("before");
      expect(await published()).toEqual(expect.arrayContaining(original));
    });
  }
);

describe("a durable recover while a host transaction on its database is open", () => {
  test("on a file, is refused by the write lock the host holds, and removes nothing", async () => {
    const databases = fileDatabases;
    const { database, files, inHost, original, published, read, rewrite } =
      await setup(databases);
    const elsewhere = new Artifacts({
      files,
      store: new SqliteArtifactStore({
        database: databases.connect(database),
        scope: "s",
      }),
    });
    await inHost("rollback", async (joined) => {
      await rewrite(joined);
      await expect(elsewhere.recover()).rejects.toThrow(HELD);
      expect(await published()).toHaveLength(original.length + 1);
    });

    expect(await read()).toBe("before");
    expect(await published()).toHaveLength(original.length + 1);
  });

  test("in memory, is refused while the host holds the only connection, and removes nothing", async () => {
    const { durable, inHost, original, published, read, rewrite } =
      await setup(memoryDatabases);
    await inHost("rollback", async (joined) => {
      await rewrite(joined);
      await expect(durable.recover()).rejects.toThrow(HELD);
    });

    expect(await published()).toHaveLength(original.length + 1);
    expect(await read()).toBe("before");
  });
});

describe.each(STORE_KINDS)(
  "a durable recover started while a %s store's transaction runs",
  (kind) => {
    async function running(outcome: "commit" | "rollback") {
      const store = await openStore(kind);
      const root = await mkdtemp(join(tmpdir(), "artifact-queued-"));
      roots.push(root);
      const files = blobFiles(root);
      const durable = new Artifacts({ files, store });
      const created = await durable.create({
        entries: { "a.txt": { bytes: "before" } },
        name: "A",
        type: "text/plain",
      });
      const original = await publishedIn(root);
      const written = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const transaction = required(store.transaction?.bind(store));
      const settled = transaction(async (view) => {
        await new Artifacts({ files, store: view }).write({
          artifactId: created.id,
          changes: { put: { "a.txt": { bytes: "after" } } },
        });
        written.resolve();
        await proceed.promise;
        if (outcome === "rollback") {
          throw new Error(ROLLED_BACK);
        }
      }).catch((error: unknown) => {
        if (!(error instanceof Error && error.message === ROLLED_BACK)) {
          throw error;
        }
      });
      await written.promise;
      let recovered = false;
      const recovering = durable.recover().then(() => {
        recovered = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const waited = !recovered;
      const during = await publishedIn(root);
      proceed.resolve();
      await settled;
      await recovering;
      const artifact = required(await durable.get(created.id));
      const file = await durable.readFile(
        required(artifact.contentId),
        "a.txt"
      );
      return {
        after: await publishedIn(root),
        during,
        original,
        text: new TextDecoder().decode(required(file).blob),
        waited,
      };
    }

    test("waits for it to roll back, then keeps the original and reclaims what it published", async () => {
      const outcome = await running("rollback");
      expect(outcome.waited).toBe(true);
      expect(outcome.during).toHaveLength(outcome.original.length + 1);
      expect(outcome.after).toEqual(outcome.original);
      expect(outcome.text).toBe("before");
    });

    test("waits for it to commit, then reclaims the file it retired", async () => {
      const outcome = await running("commit");
      expect(outcome.waited).toBe(true);
      expect(outcome.after).toHaveLength(1);
      expect(outcome.after).not.toEqual(outcome.original);
      expect(outcome.text).toBe("after");
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
});

describe.each(STORE_KINDS)(
  "a manager over a %s store's transaction view",
  (kind) => {
    test("leaves the file a change retired when the transaction's work throws", async () => {
      const store = await openStore(kind);
      const root = await mkdtemp(join(tmpdir(), "artifact-view-"));
      roots.push(root);
      const files = blobFiles(root);
      const outer = new Artifacts({ files, store });
      const created = await outer.create({
        entries: { "a.txt": { bytes: "before" } },
        name: "A",
        type: "text/plain",
      });
      const transaction = required(store.transaction?.bind(store));

      await expect(
        transaction(async (view) => {
          const inner = new Artifacts({ files, store: view });
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
