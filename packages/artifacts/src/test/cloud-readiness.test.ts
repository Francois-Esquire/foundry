import { describe, expect, it, vi } from "vitest";
import { Artifacts } from "../artifacts";
import type { BlobFileEntry, BlobFiles } from "../blob-staging";
import { fileResponse } from "../delivery";
import { FileTooLargeError, StaleContentError } from "../errors";
import { contentIdSchema } from "../ids";
import type { ArtifactStore } from "../store";
import { MemoryArtifactStore } from "../store/memory";
import { SqliteArtifactStore } from "../store/sqlite";
import { runArtifactTransaction } from "../transaction";
import { libsqlDatabases } from "./helpers/sqlite";

const CDN_BLOB_URL = /^https:\/\/cdn\.example\.test\/blob-/;

function createMemoryBlobFiles(
  entries: Map<
    string,
    { readonly bytes: Uint8Array; readonly modifiedAt: Date }
  >,
  options: { readonly urlBase?: string } = {}
): BlobFiles {
  return {
    async *list(): AsyncIterable<BlobFileEntry> {
      for (const [path, entry] of entries) {
        yield { modifiedAt: entry.modifiedAt, path };
      }
    },
    async publish(bytes) {
      const path = `blob-${crypto.randomUUID()}`;
      entries.set(path, { bytes: bytes.slice(), modifiedAt: new Date() });
      return path;
    },
    async *read(path, range) {
      const entry = entries.get(path);
      if (entry) {
        yield entry.bytes.slice(range.start, range.end);
      }
    },
    async remove(path) {
      entries.delete(path);
    },
    ...(options.urlBase === undefined
      ? {}
      : {
          url: async (path: string) => `${options.urlBase}/${path}`,
        }),
  };
}

describe("Artifacts cloud-native seams", () => {
  it("supports configurable chunkBytes and infers chunk size on read", async () => {
    const store = new MemoryArtifactStore();
    const artifacts = new Artifacts({ chunkBytes: 4, store });
    const created = await artifacts.create({
      entries: { "data.txt": { bytes: "abcdefghij" } },
      name: "chunked",
      type: "text/plain",
    });
    const contentId = created.content?.id;
    expect(contentId).toBeDefined();
    if (!contentId) {
      return;
    }

    const blobs = await store.listBlobs();
    expect(blobs.length).toBeGreaterThanOrEqual(4); // 1 manifest + 3 chunks (4, 4, 2)

    const reader = new Artifacts({ store });
    const full = await reader.readFile(contentId, "data.txt");
    expect(new TextDecoder().decode(full?.blob)).toBe("abcdefghij");

    const ranged = await reader.readFileRange(contentId, "data.txt", {
      end: 7,
      start: 2,
    });
    const parts: Uint8Array[] = [];
    if (ranged) {
      for await (const chunk of ranged.body) {
        parts.push(chunk);
      }
    }
    const text = new TextDecoder().decode(
      parts.reduce((acc, part) => {
        const next = new Uint8Array(acc.length + part.length);
        next.set(acc);
        next.set(part, acc.length);
        return next;
      }, new Uint8Array())
    );
    expect(text).toBe("cdefg");
  });

  it("respects orphanGraceMs and runs BlobFiles I/O outside store.transaction in recover()", async () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const fileMap = new Map<
      string,
      { readonly bytes: Uint8Array; readonly modifiedAt: Date }
    >([
      [
        "recent-orphan",
        {
          bytes: new Uint8Array([1]),
          modifiedAt: new Date(now.getTime() - 10_000),
        },
      ],
      [
        "old-orphan",
        {
          bytes: new Uint8Array([2]),
          modifiedAt: new Date(now.getTime() - 120_000),
        },
      ],
    ]);
    let insideTx = false;
    let filesListedInsideTx = false;
    const inner = new MemoryArtifactStore();
    const wrappedStore: typeof inner = Object.assign(
      Object.create(Object.getPrototypeOf(inner)),
      inner,
      {
        commit: inner.commit.bind(inner),
        findBlobByPath: inner.findBlobByPath.bind(inner),
        findBlobs: inner.findBlobs.bind(inner),
        findContent: inner.findContent.bind(inner),
        findContentByTag: inner.findContentByTag.bind(inner),
        findReferences: inner.findReferences.bind(inner),
        getArtifact: inner.getArtifact.bind(inner),
        getBlob: inner.getBlob.bind(inner),
        getContent: inner.getContent.bind(inner),
        listArtifacts: inner.listArtifacts.bind(inner),
        listBlobs: inner.listBlobs.bind(inner),
        listBlobsPage: inner.listBlobsPage.bind(inner),
        listContents: inner.listContents.bind(inner),
        listContentsPage: inner.listContentsPage.bind(inner),
        async transaction<T>(
          work: Parameters<MemoryArtifactStore["transaction"]>[0] extends (
            view: infer V
          ) => Promise<unknown>
            ? (view: V) => Promise<T>
            : never
        ) {
          insideTx = true;
          try {
            return await inner.transaction(work);
          } finally {
            insideTx = false;
          }
        },
      }
    );
    const baseFiles = createMemoryBlobFiles(fileMap);
    const files: BlobFiles = {
      ...baseFiles,
      async *list(options) {
        if (insideTx) {
          filesListedInsideTx = true;
        }
        yield* baseFiles.list(options);
      },
    };

    const artifacts = new Artifacts({
      clock: () => now,
      files,
      store: wrappedStore,
    });
    await artifacts.recover({ orphanGraceMs: 60_000 });

    expect(filesListedInsideTx).toBe(false);
    expect(fileMap.has("recent-orphan")).toBe(true);
    expect(fileMap.has("old-orphan")).toBe(false);
  });

  it("supports presigned redirect in fileResponse() and maxReadBytes guard", async () => {
    const fileMap = new Map<
      string,
      { readonly bytes: Uint8Array; readonly modifiedAt: Date }
    >();
    const files = createMemoryBlobFiles(fileMap, {
      urlBase: "https://cdn.example.test",
    });
    const store = new MemoryArtifactStore();
    const artifacts = new Artifacts({ files, maxReadBytes: 4, store });
    const created = await artifacts.create({
      entries: { "big.txt": { bytes: "hello world" } },
      name: "doc",
      type: "text/plain",
    });
    const { content } = created;
    expect(content).not.toBeNull();
    if (!content) {
      return;
    }

    await expect(artifacts.readFile(content.id, "big.txt")).rejects.toThrow(
      FileTooLargeError
    );

    const redirected = await fileResponse(artifacts, content, "big.txt", {
      headers: { "Cache-Control": "public, max-age=3600" },
      range: "bytes=0-3",
      redirect: true,
    });
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("Location")).toMatch(CDN_BLOB_URL);
    expect(redirected.headers.get("Cache-Control")).toBe("private, no-store");

    const unsafeFiles = createMemoryBlobFiles(fileMap, {
      urlBase: "file:///etc/blobs",
    });
    const unsafeArtifacts = new Artifacts({ files: unsafeFiles, store });
    const fallback = await fileResponse(unsafeArtifacts, content, "big.txt", {
      headers: { "Cache-Control": "public, max-age=60" },
      range: "bytes=0-4",
      redirect: true,
    });
    expect(fallback.status).toBe(206);
    expect(fallback.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(await fallback.text()).toBe("hello");
  });

  it("paginates sweep({ limit, cursor }) cleanly", async () => {
    let time = new Date("2026-10-01T00:00:00Z").getTime();
    const store = new MemoryArtifactStore();
    const artifacts = new Artifacts({ clock: () => new Date(time), store });
    const a1 = await artifacts.create({
      entries: { "a.txt": { bytes: "v1" } },
      name: "paged-sweep-1",
      type: "text/plain",
    });
    const a2 = await artifacts.create({
      entries: { "b.txt": { bytes: "v1" } },
      name: "paged-sweep-2",
      type: "text/plain",
    });
    if (!(a1.content && a2.content)) {
      throw new Error("expected initial contents");
    }
    time += 1000;
    await artifacts.revise({
      artifactId: a1.id,
      changes: { put: { "a.txt": { bytes: "v2" } } },
      contentId: a1.content.id,
      expectedUpdatedAt: a1.content.updatedAt,
    });
    await artifacts.revise({
      artifactId: a2.id,
      changes: { put: { "b.txt": { bytes: "v2" } } },
      contentId: a2.content.id,
      expectedUpdatedAt: a2.content.updatedAt,
    });
    await artifacts.select({ artifactId: a1.id, contentId: a1.content.id });
    await artifacts.select({ artifactId: a2.id, contentId: a2.content.id });

    const first = await artifacts.sweep({
      limit: 1,
      olderThan: new Date(time + 5000),
    });
    expect(first.nextCursor).toBeDefined();
    const second = await artifacts.sweep({
      cursor: first.nextCursor,
      limit: 10,
      olderThan: new Date(time + 5000),
    });
    expect(first.contents + second.contents).toBe(2);
  });

  const databases = libsqlDatabases("memory");

  it.each(["memory", "sqlite"] as const)(
    "enforces write preconditions CAS in %s store and supports exactTotal: false on sqlite",
    async (kind) => {
      const store =
        kind === "sqlite"
          ? new SqliteArtifactStore({
              database: await databases.open(),
              exactTotal: false,
              scope: "art-cas",
            })
          : new MemoryArtifactStore();
      const { value: created } = await runArtifactTransaction(
        store,
        (ops) =>
          ops.create({
            entries: { "hello.txt": { bytes: "v1" } },
            name: "cas",
            type: "text/plain",
          }),
        {}
      );
      if (kind === "sqlite") {
        const listed = await store.listArtifacts({ limit: 10 });
        expect(listed.artifacts).toHaveLength(1);
        expect(listed.total).toBeUndefined();
      }
      await expect(
        store.commit({
          preconditions: {
            artifactContentIds: { [created.id]: null },
          },
          putArtifacts: [created],
        })
      ).rejects.toBeInstanceOf(StaleContentError);

      try {
        await store.commit({
          preconditions: {
            contentUpdatedAt: {
              [contentIdSchema.parse("00000000-0000-4000-8000-000000000099")]:
                new Date(0),
            },
          },
          putArtifacts: [created],
        });
        expect.unreachable("expected StaleContentError");
      } catch (error) {
        expect(error).toBeInstanceOf(StaleContentError);
        expect((error as StaleContentError).artifactId).toBeNull();
      }
    }
  );

  it.each([
    {
      chunkBytes: 6 * 1024 * 1024,
      label: "9 MiB with 6 MiB chunks",
      totalBytes: 9 * 1024 * 1024,
    },
    {
      chunkBytes: 5 * 1024 * 1024,
      label: "10 MiB with 5 MiB chunks",
      totalBytes: 10 * 1024 * 1024,
    },
  ])(
    "reads full and ranged payloads written with ambiguous custom chunkBytes ($label)",
    async ({ chunkBytes, totalBytes }) => {
      const payload = new Uint8Array(totalBytes);
      for (let i = 0; i < totalBytes; i += 4096) {
        payload[i] = (i / 4096) % 256;
      }
      const store = new MemoryArtifactStore();
      const writer = new Artifacts({
        chunkBytes,
        maxFileBytes: totalBytes + 1024,
        maxTreeBytes: totalBytes + 1024,
        store,
      });
      const created = await writer.create({
        entries: { "big.bin": { bytes: payload } },
        name: "custom-chunk",
        type: "application/octet-stream",
      });
      const contentId = created.content?.id;
      expect(contentId).toBeDefined();
      if (!contentId) {
        return;
      }

      const reader = new Artifacts({
        maxFileBytes: totalBytes + 1024,
        maxTreeBytes: totalBytes + 1024,
        store,
      });
      const full = await reader.readFile(contentId, "big.bin");
      expect(full?.blob.byteLength).toBe(totalBytes);
      expect(full?.blob[0]).toBe(payload[0]);
      expect(full?.blob[chunkBytes]).toBe(payload[chunkBytes]);
      expect(full?.blob[totalBytes - 4096]).toBe(payload[totalBytes - 4096]);

      const start = chunkBytes - 16;
      const end = chunkBytes + 32;
      const ranged = await reader.readFileRange(contentId, "big.bin", {
        end,
        start,
      });
      expect(ranged).not.toBeNull();
      const chunks: Uint8Array[] = [];
      if (ranged) {
        for await (const part of ranged.body) {
          chunks.push(part);
        }
      }
      const combined = new Uint8Array(end - start);
      let offset = 0;
      for (const part of chunks) {
        combined.set(part, offset);
        offset += part.byteLength;
      }
      expect(combined).toEqual(payload.slice(start, end));
    }
  );

  it("does not delete a blob committed concurrently during recover() files.list()", async () => {
    const fileMap = new Map<
      string,
      { readonly bytes: Uint8Array; readonly modifiedAt: Date }
    >([
      [
        "stale-orphan",
        {
          bytes: new Uint8Array([9]),
          modifiedAt: new Date("2026-10-15T10:00:00Z"),
        },
      ],
    ]);
    const now = new Date("2026-10-15T12:00:00Z");
    const store = new MemoryArtifactStore();
    let concurrentDone = false;
    let artifactsRef: Artifacts | undefined;

    const baseFiles = createMemoryBlobFiles(fileMap);
    const files: BlobFiles = {
      ...baseFiles,
      async *list(options) {
        if (!concurrentDone && artifactsRef !== undefined) {
          concurrentDone = true;
          await artifactsRef.create({
            entries: { "live.txt": { bytes: "concurrent-commit" } },
            name: "concurrent",
            type: "text/plain",
          });
        }
        yield* baseFiles.list(options);
      },
    };
    const artifacts = new Artifacts({
      clock: () => now,
      files,
      store,
    });
    artifactsRef = artifacts;

    await artifacts.recover({ orphanGraceMs: 0 });
    expect(fileMap.has("stale-orphan")).toBe(false);
    // The concurrently committed blob must still exist and be readable!
    const listed = await artifacts.list();
    expect(listed.items).toHaveLength(1);
    const contentId = listed.items[0]?.content?.id;
    expect(contentId).toBeDefined();
    if (contentId) {
      const read = await artifacts.readFile(contentId, "live.txt");
      expect(new TextDecoder().decode(read?.blob)).toBe("concurrent-commit");
    }
  });

  it("returns nextCursor from bounded recover({ limit: 1 }) for multi-page continuation", async () => {
    const store = new MemoryArtifactStore();
    const artifacts = new Artifacts({ store });
    const a1 = await artifacts.create({
      entries: { "a.txt": { bytes: "1" } },
      name: "first",
      type: "text/plain",
    });
    const a2 = await artifacts.create({
      entries: { "b.txt": { bytes: "2" } },
      name: "second",
      type: "text/plain",
    });
    const a3 = await artifacts.create({
      entries: { "c.txt": { bytes: "3" } },
      name: "third",
      type: "text/plain",
    });

    const replayed: string[] = [];
    artifacts.observe((id, cause) => {
      if (cause === "recovery") {
        replayed.push(id);
      }
    });

    const p1 = await artifacts.recover({ limit: 1 });
    expect(p1.nextCursor).toBeDefined();
    const p2 = await artifacts.recover({ cursor: p1.nextCursor, limit: 1 });
    expect(p2.nextCursor).toBeDefined();
    const p3 = await artifacts.recover({ cursor: p2.nextCursor, limit: 1 });
    expect(p3.nextCursor).toBeUndefined();

    expect(new Set(replayed)).toEqual(new Set([a1.id, a2.id, a3.id]));
    expect(replayed).toHaveLength(3);
  });

  it("routes paged sweep({ limit }) through store.listContentsPage() without full listContents()", async () => {
    const inner = new MemoryArtifactStore();
    let listContentsCalls = 0;
    let listContentsPageCalls = 0;
    const wrapView = <
      S extends Pick<MemoryArtifactStore, "listContents" | "listContentsPage">,
    >(
      target: S
    ): S =>
      new Proxy(target, {
        get(obj, prop, receiver) {
          if (prop === "listContents") {
            return (
              artifactId?: Parameters<MemoryArtifactStore["listContents"]>[0]
            ) => {
              listContentsCalls += 1;
              return obj.listContents(artifactId);
            };
          }
          if (prop === "listContentsPage") {
            return (
              query?: Parameters<MemoryArtifactStore["listContentsPage"]>[0]
            ) => {
              listContentsPageCalls += 1;
              return obj.listContentsPage(query);
            };
          }
          if (prop === "transaction") {
            return (work: (view: S) => Promise<unknown>) =>
              inner.transaction((view) => work(wrapView(view as unknown as S)));
          }
          const value = Reflect.get(obj, prop, receiver);
          return typeof value === "function" ? value.bind(obj) : value;
        },
      });
    const spyingStore = wrapView(inner);
    const artifacts = new Artifacts({ store: spyingStore });
    await artifacts.create({
      entries: { "a.txt": { bytes: "v1" } },
      name: "sweep-page",
      type: "text/plain",
    });

    listContentsCalls = 0;
    listContentsPageCalls = 0;
    await artifacts.sweep({
      limit: 5,
      olderThan: new Date("2099-01-01T00:00:00Z"),
    });
    expect(listContentsCalls).toBe(0);
    expect(listContentsPageCalls).toBe(1);
  });

  it("copies reused streaming buffers in split() so earlier bytes are not corrupted", async () => {
    const store = new MemoryArtifactStore();
    const artifacts = new Artifacts({ chunkBytes: 6, store });
    async function* reusedBufferStream(): AsyncIterable<Uint8Array> {
      const shared = new Uint8Array(4);
      shared.set([65, 66, 67, 68]); // "ABCD"
      yield shared;
      shared.set([69, 70, 71, 72]); // "EFGH" (overwrites shared!)
      yield shared;
      shared.set([73, 74, 75, 76]); // "IJKL" (overwrites shared!)
      yield shared;
    }
    const created = await artifacts.create({
      entries: { "stream.txt": { source: reusedBufferStream() } },
      name: "reused-buf",
      type: "text/plain",
    });
    const contentId = created.content?.id;
    expect(contentId).toBeDefined();
    if (!contentId) {
      return;
    }
    const read = await artifacts.readFile(contentId, "stream.txt");
    expect(new TextDecoder().decode(read?.blob)).toBe("ABCDEFGHIJKL");
  });

  it("prunes same-ms orphans by default while skipping future-dated files and validates orphanGraceMs", async () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const fileMap = new Map<
      string,
      { readonly bytes: Uint8Array; readonly modifiedAt: Date }
    >([
      ["same-ms", { bytes: new Uint8Array([1]), modifiedAt: new Date(now) }],
      [
        "future-file",
        {
          bytes: new Uint8Array([2]),
          modifiedAt: new Date(now.getTime() + 1000),
        },
      ],
    ]);
    const artifacts = new Artifacts({
      clock: () => now,
      files: createMemoryBlobFiles(fileMap),
      store: new MemoryArtifactStore(),
    });
    await artifacts.recover();
    expect(fileMap.has("same-ms")).toBe(false);
    expect(fileMap.has("future-file")).toBe(true);

    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Artifacts({ orphanGraceMs: invalid })).toThrow(
        RangeError
      );
      await expect(
        artifacts.recover({ orphanGraceMs: invalid })
      ).rejects.toThrow(RangeError);
    }
  });

  it("never embeds a manifest blob as a child chunk under mixed chunkBytes", async () => {
    const store = new MemoryArtifactStore();
    const writerA = new Artifacts({ chunkBytes: 4, store });
    const writerB = new Artifacts({ chunkBytes: 8, store });

    const a = await writerA.create({
      entries: { "a.txt": { bytes: "abcdefgh" } },
      name: "writer-a",
      type: "text/plain",
    });
    const b = await writerB.create({
      entries: { "b.txt": { bytes: "abcdefgh12345678" } },
      name: "writer-b",
      type: "text/plain",
    });

    expect(a.content).not.toBeNull();
    expect(b.content).not.toBeNull();
    if (!(a.content && b.content)) {
      return;
    }

    const reader = new Artifacts({ store });
    const readA = await reader.readFile(a.content.id, "a.txt");
    const readB = await reader.readFile(b.content.id, "b.txt");
    expect(new TextDecoder().decode(readA?.blob)).toBe("abcdefgh");
    expect(new TextDecoder().decode(readB?.blob)).toBe("abcdefgh12345678");
  });

  it("skips chunk-0 store lookup for empty range reads on chunked blobs", async () => {
    const store = new MemoryArtifactStore();
    const artifacts = new Artifacts({ chunkBytes: 4, store });
    const created = await artifacts.create({
      entries: { "data.txt": { bytes: "abcdefgh" } },
      name: "empty-range",
      type: "text/plain",
    });
    const contentId = created.content?.id;
    expect(contentId).toBeDefined();
    if (!contentId) {
      return;
    }
    const getBlobSpy = vi.spyOn(store, "getBlob");
    const ranged = await artifacts.readFileRange(contentId, "data.txt", {
      end: 3,
      start: 3,
    });
    expect(ranged).not.toBeNull();
    const callsBeforeStream = getBlobSpy.mock.calls.length;
    const chunks: Uint8Array[] = [];
    if (ranged) {
      for await (const chunk of ranged.body) {
        chunks.push(chunk);
      }
    }
    expect(chunks).toEqual([]);
    expect(getBlobSpy.mock.calls.length).toBe(callsBeforeStream);
  });

  it("allows tx.create() followed by fenced tx.write() in the same transaction", async () => {
    const store = new MemoryArtifactStore();
    const artifacts = new Artifacts({ store });
    const result = await artifacts.transaction(async (tx) => {
      const created = await tx.create({
        entries: { "doc.txt": { bytes: "v1" } },
        name: "multi-op",
        type: "text/plain",
      });
      if (!created.content) {
        throw new Error("expected initial content");
      }
      const written = await tx.write({
        artifactId: created.id,
        changes: { put: { "doc.txt": { bytes: "v2" } } },
        expectedContentId: created.contentId,
        expectedUpdatedAt: created.content.updatedAt,
      });
      return written;
    });
    const read = await artifacts.readFile(result.id, "doc.txt");
    expect(new TextDecoder().decode(read?.blob)).toBe("v2");
  });

  it("enforces freeze() expectedUpdatedAt CAS via commit preconditions on non-transactional stores", async () => {
    const inner = new MemoryArtifactStore();
    const nonTxStore: ArtifactStore = {
      commit: (write) => inner.commit(write),
      findBlobByPath: (path) => inner.findBlobByPath(path),
      findBlobs: (digest) => inner.findBlobs(digest),
      findContent: (artifactId, by) => inner.findContent(artifactId, by),
      findContentByTag: (artifactId, tag) =>
        inner.findContentByTag(artifactId, tag),
      findReferences: (id) => inner.findReferences(id),
      getArtifact: (id) => inner.getArtifact(id),
      getBlob: (id) => inner.getBlob(id),
      getContent: (id) => inner.getContent(id),
      listArtifacts: (query) => inner.listArtifacts(query),
      listBlobs: () => inner.listBlobs(),
      listBlobsPage: (query) => inner.listBlobsPage(query),
      listContents: (artifactId) => inner.listContents(artifactId),
      listContentsPage: (query) => inner.listContentsPage(query),
    };
    const artifacts = new Artifacts({ store: nonTxStore });
    const created = await artifacts.create({
      entries: { "a.txt": { bytes: "v1" } },
      name: "freeze-cas",
      type: "text/plain",
    });
    const { content } = created;
    expect(content).not.toBeNull();
    if (!content) {
      return;
    }

    let raced = false;
    const racingStore: ArtifactStore = {
      ...nonTxStore,
      async commit(write) {
        if (!raced) {
          raced = true;
          await artifacts.write({
            artifactId: created.id,
            changes: { put: { "a.txt": { bytes: "v2-raced" } } },
          });
        }
        return inner.commit(write);
      },
    };
    const racer = new Artifacts({ store: racingStore });
    await expect(
      racer.freeze(content.id, { expectedUpdatedAt: content.updatedAt })
    ).rejects.toBeInstanceOf(StaleContentError);
  });

  it("rejects oversized inline blobs before calling store.getBlob and validates constructor limits", async () => {
    const store = new MemoryArtifactStore();
    const writer = new Artifacts({ store });
    const created = await writer.create({
      entries: { "inline.txt": { bytes: "hello world" } },
      name: "inline-limit",
      type: "text/plain",
    });
    const contentId = created.content?.id;
    expect(contentId).toBeDefined();
    if (!contentId) {
      return;
    }

    const reader = new Artifacts({ maxReadBytes: 4, store });
    const getBlobSpy = vi.spyOn(store, "getBlob");
    await expect(reader.readFile(contentId, "inline.txt")).rejects.toThrow(
      FileTooLargeError
    );
    expect(getBlobSpy).not.toHaveBeenCalled();

    expect(() => new Artifacts({ maxReadBytes: 0, store })).not.toThrow();

    for (const badChunk of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Artifacts({ chunkBytes: badChunk, store })).toThrow(
        RangeError
      );
      expect(() =>
        runArtifactTransaction(store, () => Promise.resolve(), {
          chunkBytes: badChunk,
        })
      ).toThrow(RangeError);
    }
    for (const badRead of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Artifacts({ maxReadBytes: badRead, store })).toThrow(
        RangeError
      );
      expect(() =>
        runArtifactTransaction(store, () => Promise.resolve(), {
          maxReadBytes: badRead,
        })
      ).toThrow(RangeError);
    }
  });
});
