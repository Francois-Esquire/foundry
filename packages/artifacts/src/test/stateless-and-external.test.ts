import { describe, expect, it, vi } from "vitest";
import { Artifacts } from "../artifacts";
import { ArtifactChange } from "../change";
import { InvalidArtifactInputError } from "../errors";
import { blobIdSchema } from "../ids";
import type { ArtifactStore } from "../store";
import { MemoryArtifactStore } from "../store/memory";
import { SqliteArtifactStore } from "../store/sqlite";
import { describeArtifactStore } from "../testing/store";
import { runArtifactTransaction } from "../transaction";
import { libsqlDatabases } from "./helpers/sqlite";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const FIXED_TIME = new Date("2026-06-01T12:00:00.000Z");

describe("ArtifactChange.putBlob path lookup", () => {
  it("uses findBlobByPath instead of scanning listBlobs when available", async () => {
    const base = new MemoryArtifactStore();
    const listBlobs = vi.spyOn(base, "listBlobs");
    const findBlobByPath = vi.spyOn(base, "findBlobByPath");
    const blobA = {
      byteLength: 4,
      createdAt: FIXED_TIME,
      digest: DIGEST_A,
      id: blobIdSchema.parse("blob-a"),
      path: "r2/a",
    };
    const blobB = {
      byteLength: 4,
      createdAt: FIXED_TIME,
      digest: DIGEST_B,
      id: blobIdSchema.parse("blob-b"),
      path: "r2/a",
    };
    await base.commit({ putBlobs: [blobA] });

    const change = ArtifactChange.begin(base);
    await expect(change.putBlob(blobB)).rejects.toThrow(
      "Blob backing path already belongs to another blob"
    );
    expect(findBlobByPath).toHaveBeenCalledWith("r2/a");
    expect(listBlobs).not.toHaveBeenCalled();

    await change.putBlob({ ...blobB, path: "r2/b" });
    expect(listBlobs).not.toHaveBeenCalled();
  });

  it("falls back to listBlobs when a custom store omits findBlobByPath", async () => {
    const base = new MemoryArtifactStore();
    const blobA = {
      byteLength: 4,
      createdAt: FIXED_TIME,
      digest: DIGEST_A,
      id: blobIdSchema.parse("blob-a"),
      path: "r2/a",
    };
    await base.commit({ putBlobs: [blobA] });

    const minimal: ArtifactStore = {
      commit: (write) => base.commit(write),
      findBlobs: (digest) => base.findBlobs(digest),
      findReferences: (id) => base.findReferences(id),
      getArtifact: (id) => base.getArtifact(id),
      getBlob: (id) => base.getBlob(id),
      getContent: (id) => base.getContent(id),
      listArtifacts: (query) => base.listArtifacts(query),
      listBlobs: () => base.listBlobs(),
      listContents: (artifactId) => base.listContents(artifactId),
    };
    const change = ArtifactChange.begin(minimal);
    await expect(
      change.putBlob({
        ...blobA,
        id: blobIdSchema.parse("blob-b"),
      })
    ).rejects.toThrow("Blob backing path already belongs to another blob");
  });

  it("finds blobs by path on SqliteArtifactStore", async () => {
    const databases = libsqlDatabases("memory");
    const database = await databases.open();
    const store = new SqliteArtifactStore({ database, scope: "path-index" });
    const blob = {
      byteLength: 10,
      createdAt: FIXED_TIME,
      digest: DIGEST_A,
      id: blobIdSchema.parse("blob-sqlite"),
      path: "objects/ab/cd",
    };
    await store.commit({ putBlobs: [blob] });
    expect(await store.findBlobByPath("objects/ab/cd")).toEqual(blob);
    expect(await store.findBlobByPath("objects/missing")).toBeNull();
    expect(await store.findBlobByPath("bad\u0000path")).toBeNull();
  });
});

describe("pre-staged external blob input and stateless transactions", () => {
  it("commits pre-staged external blobs as pure metadata via runArtifactTransaction with injectable clock and id", async () => {
    const store = new MemoryArtifactStore();
    let seq = 0;
    const id = () => {
      seq += 1;
      return `id-${String(seq)}`;
    };
    const clock = () => new Date(FIXED_TIME.getTime() + seq * 1000);

    const { effects, value: created } = await runArtifactTransaction(
      store,
      (artifacts) =>
        artifacts.create({
          entries: {
            "a.bin": {
              bytes: 128,
              digest: DIGEST_A,
              mime: "application/octet-stream",
              path: "r2://bucket/key-1",
            },
            "copy.bin": {
              bytes: 128,
              digest: DIGEST_A,
              mime: "application/octet-stream",
              path: "r2://bucket/key-1",
            },
          },
          name: "External",
          type: "application/octet-stream",
        }),
      { clock, id }
    );

    expect(created.id).toBe("id-1");
    expect(created.createdAt).toEqual(new Date("2026-06-01T12:00:01.000Z"));
    expect(effects.changed.has(created.id)).toBe(true);
    expect(effects.published.size).toBe(0);

    const fileA = created.content?.tree["a.bin"];
    const fileCopy = created.content?.tree["copy.bin"];
    expect(fileA?.type).toBe("file");
    expect(fileCopy?.type).toBe("file");
    if (fileA?.type === "file" && fileCopy?.type === "file") {
      expect(fileA.blobId).toBe(fileCopy.blobId);
      const storedBlob = await store.getBlob(fileA.blobId);
      expect(storedBlob).toMatchObject({
        byteLength: 128,
        digest: DIGEST_A,
        path: "r2://bucket/key-1",
      });
    }

    await expect(
      runArtifactTransaction(store, (artifacts) =>
        artifacts.create({
          entries: {
            "conflict.bin": {
              bytes: 64,
              digest: DIGEST_B,
              path: "r2://bucket/key-1",
            },
          },
          name: "Conflict",
          type: "text/plain",
        })
      )
    ).rejects.toThrow("Blob backing path already belongs to another blob");

    await expect(
      runArtifactTransaction(store, (artifacts) =>
        artifacts.create({
          entries: {
            "bad.bin": {
              bytes: 10,
              digest: "not-a-digest",
              path: "r2://bucket/key-2",
            },
          },
          name: "Bad",
          type: "text/plain",
        })
      )
    ).rejects.toBeInstanceOf(InvalidArtifactInputError);
  });

  it("supports pre-staged external blob input and injectable clock/id on Artifacts", async () => {
    const store = new MemoryArtifactStore();
    let seq = 0;
    const artifacts = new Artifacts({
      clock: () => FIXED_TIME,
      id: () => {
        seq += 1;
        return `art-${String(seq)}`;
      },
      store,
    });

    const created = await artifacts.create({
      entries: {
        "doc.txt": {
          bytes: 5,
          digest: DIGEST_A,
          mime: "text/plain",
          path: "convex://storage/1",
        },
      },
      name: "Doc",
      type: "text/plain",
    });

    expect(created.id).toBe("art-1");
    expect(created.createdAt).toEqual(FIXED_TIME);
    const entry = created.content?.tree["doc.txt"];
    expect(entry).toMatchObject({
      bytes: 5,
      digest: DIGEST_A,
      mime: "text/plain",
      type: "file",
    });
  });

  it("handles optional total from cloud-style stores without requiring COUNT(*)", async () => {
    const base = new MemoryArtifactStore();
    const cloudLike: ArtifactStore = {
      commit: (write) => base.commit(write),
      findBlobByPath: (path) => base.findBlobByPath(path),
      findBlobs: (digest) => base.findBlobs(digest),
      findReferences: (id) => base.findReferences(id),
      getArtifact: (id) => base.getArtifact(id),
      getBlob: (id) => base.getBlob(id),
      getContent: (id) => base.getContent(id),
      listArtifacts: async (query) => {
        const listing = await base.listArtifacts(query);
        return { artifacts: listing.artifacts };
      },
      listBlobs: () => base.listBlobs(),
      listContents: (artifactId) => base.listContents(artifactId),
    };

    const { value: page } = await runArtifactTransaction(
      cloudLike,
      async (artifacts) => {
        await artifacts.create({ name: "One", type: "text/plain" });
        await artifacts.create({ name: "Two", type: "text/plain" });
        return artifacts.list({ limit: 1 });
      }
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    expect(page.total).toBeUndefined();

    const { value: persisted } = await runArtifactTransaction(
      cloudLike,
      (artifacts) => artifacts.list({ limit: 10 }),
      { readOnly: true }
    );
    expect(persisted.items).toHaveLength(2);
    expect(persisted.total).toBeUndefined();
  });

  it("uses targeted lookups and paginated scans instead of unbounded listBlobs/listContents", async () => {
    const base = new MemoryArtifactStore();
    const counts = {
      findContent: 0,
      findContentByTag: 0,
      listBlobs: 0,
      listBlobsPage: 0,
      listContents: 0,
      listContentsPage: 0,
    };
    const track = (inner: ArtifactStore): ArtifactStore => {
      const wrapped: ArtifactStore = {
        commit: (write) => inner.commit(write),
        findBlobByPath: (path) =>
          inner.findBlobByPath?.(path) ?? Promise.resolve(null),
        findBlobs: (digest) => inner.findBlobs(digest),
        findContent: (id, by) => {
          counts.findContent += 1;
          return inner.findContent?.(id, by) ?? Promise.resolve(null);
        },
        findContentByTag: (id, tag) => {
          counts.findContentByTag += 1;
          return inner.findContentByTag?.(id, tag) ?? Promise.resolve(null);
        },
        findReferences: (id) => inner.findReferences(id),
        getArtifact: (id) => inner.getArtifact(id),
        getBlob: (id) => inner.getBlob(id),
        getContent: (id) => inner.getContent(id),
        listArtifacts: (query) => inner.listArtifacts(query),
        listBlobs: () => {
          counts.listBlobs += 1;
          return inner.listBlobs();
        },
        listBlobsPage: (query) => {
          counts.listBlobsPage += 1;
          return inner.listBlobsPage?.(query) ?? Promise.resolve({ items: [] });
        },
        listContents: (artifactId) => {
          counts.listContents += 1;
          return inner.listContents(artifactId);
        },
        listContentsPage: (query) => {
          counts.listContentsPage += 1;
          return (
            inner.listContentsPage?.(query) ?? Promise.resolve({ items: [] })
          );
        },
      };
      const transaction = inner.transaction?.bind(inner);
      return transaction === undefined
        ? wrapped
        : {
            ...wrapped,
            transaction: <T>(work: (view: ArtifactStore) => Promise<T>) =>
              transaction((view) => work(track(view))),
          };
    };
    const artifacts = new Artifacts({ store: track(base) });

    const created = await artifacts.create({
      entries: { "a.txt": { bytes: "v1" } },
      metadata: { messageId: "m1", sessionId: "s1" },
      name: "Doc",
      type: "text/plain",
    });
    const firstId = created.content?.id;
    if (firstId === undefined) {
      throw new Error("Expected initial content");
    }
    await artifacts.tag(firstId, "v1");
    expect(counts.findContentByTag).toBe(1);
    await expect(
      artifacts.findContent(created.id, { messageId: "m1", sessionId: "s1" })
    ).resolves.toMatchObject({ id: firstId });
    expect(counts.findContent).toBe(1);
    await artifacts.sweep({ olderThan: new Date(Date.now() + 10_000) });
    expect(counts.listContentsPage).toBeGreaterThan(0);
    expect(counts.listBlobsPage).toBeGreaterThan(0);
    expect(counts.listContents).toBe(0);
    expect(counts.listBlobs).toBe(0);
  });
});

function withoutTotalAndSurrogates(store: ArtifactStore): ArtifactStore {
  const wrap = (inner: ArtifactStore): ArtifactStore => {
    const findBlobByPath = inner.findBlobByPath?.bind(inner);
    const findContent = inner.findContent?.bind(inner);
    const findContentByTag = inner.findContentByTag?.bind(inner);
    const listBlobsPage = inner.listBlobsPage?.bind(inner);
    const listContentsPage = inner.listContentsPage?.bind(inner);
    const base: ArtifactStore = {
      commit: (write) => inner.commit(write),
      ...(inner.durability === undefined
        ? {}
        : { durability: inner.durability }),
      ...(findBlobByPath === undefined
        ? {}
        : { findBlobByPath: (path) => findBlobByPath(path) }),
      findBlobs: (digest) => inner.findBlobs(digest),
      ...(findContent === undefined
        ? {}
        : { findContent: (id, by) => findContent(id, by) }),
      ...(findContentByTag === undefined
        ? {}
        : { findContentByTag: (id, tag) => findContentByTag(id, tag) }),
      findReferences: (id) => inner.findReferences(id),
      getArtifact: (id) => inner.getArtifact(id),
      getBlob: (id) => inner.getBlob(id),
      getContent: (id) => inner.getContent(id),
      listArtifacts: async (query) => {
        const listing = await inner.listArtifacts(query);
        return { artifacts: listing.artifacts };
      },
      listBlobs: () => inner.listBlobs(),
      ...(listBlobsPage === undefined
        ? {}
        : { listBlobsPage: (query) => listBlobsPage(query) }),
      listContents: (artifactId) => inner.listContents(artifactId),
      ...(listContentsPage === undefined
        ? {}
        : { listContentsPage: (query) => listContentsPage(query) }),
    };
    const transaction = inner.transaction?.bind(inner);
    return transaction === undefined
      ? base
      : {
          ...base,
          transaction: <T>(work: (view: ArtifactStore) => Promise<T>) =>
            transaction((view) => work(wrap(view))),
        };
  };
  return wrap(store);
}

describeArtifactStore(
  "Cloud-style (no exactTotal, no loneSurrogates)",
  () => {
    const scopes = new Map<string, ArtifactStore>();
    return (scope) => {
      const existing = scopes.get(scope);
      if (existing) {
        return existing;
      }
      const created = withoutTotalAndSurrogates(new MemoryArtifactStore());
      scopes.set(scope, created);
      return created;
    };
  },
  { hooked: false },
  { exactTotal: false, loneSurrogates: false }
);
