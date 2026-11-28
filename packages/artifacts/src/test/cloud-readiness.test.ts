import { describe, expect, it } from "vitest";
import { Artifacts } from "../artifacts";
import type { BlobFileEntry, BlobFiles } from "../blob-staging";
import { StaleContentError } from "../errors";
import type { ArtifactId, ContentId } from "../ids";
import { MemoryArtifactStore } from "../store/memory";
import { SqliteArtifactStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";

describe("Artifacts cloud-readiness fixes", () => {
  const databases = libsqlDatabases("memory");

  it("copies reused stream buffers safely in lazy split()", async () => {
    const artifacts = new Artifacts({ store: new MemoryArtifactStore() });
    const created = await artifacts.create({ name: "doc", type: "doc" });
    const shared = new Uint8Array(4);
    async function* reusedSource() {
      shared.set([1, 2, 3, 4]);
      yield shared;
      shared.set([5, 6, 7, 8]);
      yield shared;
    }
    const written = await artifacts.write({
      artifactId: created.id,
      changes: { put: { "data.bin": { bytes: 8, source: reusedSource() } } },
    });
    const file = await artifacts.readFile(written.id, "data.bin");
    expect([...(file?.blob ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("decouples recover() BlobFiles I/O from store.transaction() and honors orphanGraceMs + future mtime", async () => {
    const inner = new MemoryArtifactStore();
    let inTransaction = false;
    let listedInsideTx = false;
    let removedInsideTx = false;
    const trackedStore: MemoryArtifactStore = Object.assign(
      Object.create(Object.getPrototypeOf(inner)),
      inner
    );
    trackedStore.transaction = async (work) =>
      inner.transaction(async (view) => {
        inTransaction = true;
        try {
          return await work(view);
        } finally {
          inTransaction = false;
        }
      });

    const now = new Date("2026-10-15T12:00:00Z");
    const removed: string[] = [];
    const entries: BlobFileEntry[] = [
      { modifiedAt: new Date("2026-10-15T11:00:00Z"), path: "old-orphan" },
      { modifiedAt: new Date("2026-10-15T11:59:30Z"), path: "recent-orphan" },
      { modifiedAt: new Date("2026-10-15T12:01:00Z"), path: "future-orphan" },
    ];
    const files: BlobFiles = {
      async *list() {
        if (inTransaction) {
          listedInsideTx = true;
        }
        for (const entry of entries) {
          yield entry;
        }
      },
      publish: async () => "p",
      async *read() {
        yield new Uint8Array();
      },
      remove: async (path) => {
        if (inTransaction) {
          removedInsideTx = true;
        }
        removed.push(path);
      },
    };

    const artifacts = new Artifacts({
      clock: () => now,
      files,
      store: trackedStore,
    });
    await artifacts.recover({ orphanGraceMs: 60_000 });
    expect(listedInsideTx).toBe(false);
    expect(removedInsideTx).toBe(false);
    expect(removed).toEqual(["old-orphan"]);

    removed.length = 0;
    await artifacts.recover();
    expect(removed).toEqual(["old-orphan", "recent-orphan"]);
  });

  it.each(["memory", "sqlite"] as const)(
    "enforces store CAS preconditions, multi-op self-mutation, freeze() CAS, and nullable artifactId in %s store",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? new SqliteArtifactStore({
              database: await databases.open(),
              scope: `artifacts-cas-${kind}`,
            })
          : new MemoryArtifactStore();
      let tick = 1_700_000_000_000;
      const artifacts = new Artifacts({
        clock: () => {
          tick += 1000;
          return new Date(tick);
        },
        store,
      });

      const created = await artifacts.create({ name: "doc", type: "doc" });
      const v1 = await artifacts.write({
        artifactId: created.id,
        changes: { put: { "a.txt": { bytes: "v1" } } },
      });

      await expect(
        store.commit({
          preconditions: {
            artifactContentIds: { [created.id]: "cnt_wrong" as ContentId },
          },
        })
      ).rejects.toBeInstanceOf(StaleContentError);

      await expect(
        store.commit({
          preconditions: {
            contentUpdatedAt: {
              ["cnt_missing" as ContentId]: new Date(1_700_000_000_000),
            },
          },
        })
      ).rejects.toMatchObject({ artifactId: null, name: "StaleContentError" });

      // Multi-op self-mutation inside one transaction must not self-conflict
      const multi = await artifacts.transaction(async (ops) => {
        const next = await ops.write({
          artifactId: created.id,
          changes: { put: { "a.txt": { bytes: "v2" } } },
          expectedContentId: v1.id,
        });
        return ops.freeze(next.id, { expectedUpdatedAt: next.updatedAt });
      });
      expect(multi.state).toBe("frozen");

      // Direct freeze() CAS rejects stale expectedUpdatedAt
      const v3 = await artifacts.revise({
        artifactId: created.id,
        changes: { put: { "a.txt": { bytes: "v3" } } },
        contentId: multi.id,
        expectedUpdatedAt: multi.updatedAt,
      });
      await expect(
        artifacts.freeze(v3.id, { expectedUpdatedAt: new Date(1) })
      ).rejects.toBeInstanceOf(StaleContentError);
    }
  );

  it("omits exact total when SqliteArtifactStore exactTotal is false", async () => {
    const store = new SqliteArtifactStore({
      database: await databases.open(),
      exactTotal: false,
      scope: "exact-total-off",
    });
    const artifacts = new Artifacts({ store });
    await artifacts.create({ name: "doc-1", type: "doc" });
    await artifacts.create({ name: "doc-2", type: "doc" });
    const page = await artifacts.list({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeUndefined();
    expect(page.nextCursor).toBeDefined();
    expect(page.items[0]?.id).not.toBe("art_missing" as ArtifactId);
  });
});
