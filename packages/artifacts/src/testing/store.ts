import { describe, expect, it } from "vitest";

import type { EventInput } from "../change";
import type { ArtifactId, BlobId, ContentId } from "../ids";
import { artifactIdSchema, blobIdSchema, contentIdSchema } from "../ids";
import type { Artifact, ArtifactEvent, Blob, Content } from "../schema";
import type {
  ArtifactListing,
  ArtifactListQuery,
  ArtifactStore,
  ArtifactStoreWrite,
} from "../store";
import { isTransactional } from "./transactional";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const AT = new Date("2026-01-01T00:00:00.000Z");

const artifactId = (): ArtifactId =>
  artifactIdSchema.parse(crypto.randomUUID());
const contentId = (): ContentId => contentIdSchema.parse(crypto.randomUUID());
const blobId = (): BlobId => blobIdSchema.parse(crypto.randomUUID());

function artifact(fields: Partial<Artifact> = {}): Artifact {
  return {
    archivedAt: null,
    contentId: null,
    createdAt: AT,
    id: artifactId(),
    metadata: { sessionId: "session" },
    name: "Notes",
    publishedAt: null,
    status: "draft",
    type: "text/plain",
    updatedAt: AT,
    ...fields,
  };
}

function unplainArrays(): unknown[][] {
  const hidden: unknown[] = ["a"];
  Object.defineProperty(hidden, "hidden", { value: () => undefined });
  const symbolic: unknown[] = ["a"];
  Object.defineProperty(symbolic, Symbol("extra"), {
    enumerable: true,
    value: 1n,
  });
  class Entries extends Array<unknown> {}
  return [hidden, symbolic, Entries.from(["a"])];
}

function holed(): number[] {
  const values: number[] = [];
  values[1] = 2;
  return values;
}

function unplainEvents(): readonly unknown[] {
  const base = event({ artifactId: artifactId(), type: "artifact.created" });
  class Instance {
    readonly artifactId = base.artifactId;
    readonly at = base.at;
    readonly id = base.id;
    readonly type = base.type;
  }
  return [
    new Instance(),
    { ...base, at: new Date() },
    { ...base, extra: Number.NaN },
    { ...base, extra: -0 },
    { ...base, extra: 1n },
    { ...base, extra: undefined },
    { ...base, extra: () => undefined },
    { ...base, extra: holed() },
    { ...base, extra: new Map() },
    { ...base, [Symbol("extra")]: 1 },
    ...unplainArrays().map((array) => ({ ...base, extra: array })),
    Object.defineProperty({ ...base }, "hidden", {
      enumerable: false,
      value: 1,
    }),
  ];
}

function removedEvent(): ArtifactEvent {
  return event({
    artifactId: artifactId(),
    artifactType: "text/plain",
    name: "gone",
    type: "artifact.removed",
  });
}

function event(input: EventInput): ArtifactEvent {
  return {
    ...input,
    at: AT.toISOString(),
    id: crypto.randomUUID(),
  } as ArtifactEvent;
}

function content(owner: ArtifactId, blobs: readonly BlobId[] = []): Content {
  return {
    artifactId: owner,
    createdAt: AT,
    digest: DIGEST,
    frozenAt: null,
    id: contentId(),
    metadata: { entry: "a.txt" },
    state: "ready",
    tag: null,
    tree: Object.fromEntries(
      blobs.map((id, index) => [
        `${String(index)}.txt`,
        { blobId: id, bytes: 1, digest: DIGEST, mime: null, type: "file" },
      ])
    ),
    updatedAt: AT,
  };
}

function sharedBlob(): Blob & { readonly bytes: Uint8Array } {
  const bytes =
    typeof SharedArrayBuffer === "undefined"
      ? new Uint8Array(2)
      : new Uint8Array(new SharedArrayBuffer(2));
  bytes.set([1, 2]);
  return { byteLength: 2, bytes, createdAt: AT, digest: DIGEST, id: blobId() };
}

function inlineBlob(digest = DIGEST): Blob {
  return {
    byteLength: 1,
    bytes: new Uint8Array([1]),
    createdAt: AT,
    digest,
    id: blobId(),
  };
}

const REFUSAL = /refused: .*use the view/;

async function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("still pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        (error: unknown) =>
          `refused: ${error instanceof Error ? error.message : String(error)}`
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requireTransaction(
  store: ArtifactStore
): <T>(work: (view: ArtifactStore) => Promise<T>) => Promise<T> {
  if (!isTransactional(store)) {
    throw new Error("An Artifact store offers transaction");
  }
  return (work) => store.transaction(work);
}

function sorted<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function scramble(write: ArtifactStoreWrite, other: BlobId): void {
  for (const row of write.putArtifacts ?? []) {
    Object.assign(row, { name: "changed" });
    (row.metadata as { list: string[] }).list.push("changed");
    row.createdAt.setTime(0);
  }
  for (const row of write.putContents ?? []) {
    for (const node of Object.values(row.tree)) {
      Object.assign(node, { blobId: other });
    }
  }
  for (const row of write.putBlobs ?? []) {
    if (row.chunks) {
      Object.assign(row, { chunks: [other] });
    }
  }
  (write.putArtifacts as Artifact[]).push(artifact({ name: "Added" }));
}

export type ScopedArtifactStores = (scope: string) => ArtifactStore;

export interface RecordingArtifactStores {
  readonly failNextCommit: () => void;
  readonly recorded: () => Promise<readonly ArtifactEvent[]>;
  readonly stores: ScopedArtifactStores;
}

export type ArtifactStoreMode =
  | { readonly hooked: false }
  | {
      readonly hooked: true;
      readonly recording: () => Promise<RecordingArtifactStores>;
    };

export interface ArtifactStoreCapabilities {
  readonly exactTotal?: boolean;
  readonly largeWrites?: boolean;
  readonly loneSurrogates?: boolean;
  readonly reentrancyGuard?: boolean;
  readonly transactions?: boolean;
}

export function describeArtifactStore(
  name: string,
  open: () => ScopedArtifactStores | Promise<ScopedArtifactStores>,
  mode: ArtifactStoreMode,
  capabilities: ArtifactStoreCapabilities = {}
): void {
  const exactTotal = capabilities.exactTotal ?? true;
  const largeWrites = capabilities.largeWrites ?? true;
  const loneSurrogates = capabilities.loneSurrogates ?? true;
  const transactions = capabilities.transactions ?? true;
  const reentrancyGuard = capabilities.reentrancyGuard ?? transactions;
  const expectListing = (
    listing: ArtifactListing,
    expectedArtifacts: readonly Artifact[],
    expectedTotal: number
  ) => {
    expect(listing.artifacts).toEqual(expectedArtifacts);
    if (exactTotal) {
      expect(listing.total).toBe(expectedTotal);
    }
  };
  if (mode.hooked) {
    describeRecordedEvents(name, mode.recording, transactions);
  }
  const fresh = async () => (await open())("conformance");
  const everyArtifact = async (store: ArtifactStore) =>
    (await store.listArtifacts({ includeArchived: true, limit: 1000 }))
      .artifacts;
  describe(`${name} Artifact store conformance`, () => {
    it("reads back every record a commit puts", async () => {
      const store = await fresh();
      const owner = artifact();
      const blob = inlineBlob();
      const version = content(owner.id, [blob.id]);
      await store.commit({
        putArtifacts: [owner],
        putBlobs: [blob],
        putContents: [version],
      });

      expect(await store.getArtifact(owner.id)).toEqual(owner);
      expect(await store.getContent(version.id)).toEqual(version);
      expect(await store.getBlob(blob.id)).toEqual(blob);
      expect(await everyArtifact(store)).toEqual([owner]);
      expect(await store.listContents()).toEqual([version]);
      expect(await store.listContents(owner.id)).toEqual([version]);
      expect(await store.listBlobs()).toEqual([{ id: blob.id }]);
      expect(await store.findBlobs(DIGEST)).toEqual([blob]);
    });

    it("answers absent records with null and empty lists", async () => {
      const store = await fresh();
      expect(await store.getArtifact(artifactId())).toBeNull();
      expect(await store.getContent(contentId())).toBeNull();
      expect(await store.getBlob(blobId())).toBeNull();
      expect(await everyArtifact(store)).toEqual([]);
      expect(await store.listContents()).toEqual([]);
      expect(await store.listBlobs()).toEqual([]);
      expect(await store.findBlobs(DIGEST)).toEqual([]);
      expect(await store.findReferences(blobId())).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("finds nothing by a key that is no string, and deletes nothing by one", async () => {
      const store = await fresh();
      const kept = artifact();
      const blob = inlineBlob();
      await store.commit({ putArtifacts: [kept], putBlobs: [blob] });
      const missing = undefined as never;
      expect(await store.getArtifact(missing)).toBeNull();
      expect(await store.getContent(missing)).toBeNull();
      expect(await store.getBlob(missing)).toBeNull();
      expect(await store.findBlobs(missing)).toEqual([]);
      expect(await store.findReferences(missing)).toEqual({
        blobIds: [],
        contentIds: [],
      });
      await store.commit({
        deleteArtifacts: [missing],
        deleteBlobs: [missing],
        deleteContents: [missing],
      });
      expect(await everyArtifact(store)).toEqual([kept]);
      expect(await store.listBlobs()).toEqual([{ id: blob.id }]);
    });

    it("lists one Artifact's Contents apart from another's", async () => {
      const store = await fresh();
      const first = artifact();
      const second = artifact();
      const mine = content(first.id);
      const theirs = content(second.id);
      await store.commit({
        putArtifacts: [first, second],
        putContents: [mine, theirs],
      });
      expect(await store.listContents(first.id)).toEqual([mine]);
      expect(sorted(await store.listContents())).toEqual(
        sorted([mine, theirs])
      );
    });

    it("finds blobs by digest and names a backing path in listings", async () => {
      const store = await fresh();
      const inline = inlineBlob();
      const backed: Blob = {
        byteLength: 1,
        createdAt: AT,
        digest: OTHER_DIGEST,
        id: blobId(),
        path: crypto.randomUUID(),
      };
      await store.commit({ putBlobs: [inline, backed] });
      expect(await store.findBlobs(OTHER_DIGEST)).toEqual([backed]);
      if (store.findBlobByPath !== undefined && backed.path !== undefined) {
        expect(await store.findBlobByPath(backed.path)).toEqual(backed);
        expect(await store.findBlobByPath("missing/path")).toBeNull();
      }
      expect(sorted(await store.listBlobs())).toEqual(
        sorted([{ id: inline.id }, { id: backed.id, path: backed.path }])
      );
    });

    it("paginates blobs and contents and performs targeted content lookups when implemented", async () => {
      const store = await fresh();
      const first = artifact({ name: "First" });
      const second = artifact({ name: "Second" });
      const blobA = { ...inlineBlob(), id: blobIdSchema.parse("blob-1") };
      const blobB: Blob = {
        byteLength: 1,
        createdAt: AT,
        digest: OTHER_DIGEST,
        id: blobIdSchema.parse("blob-2"),
        path: "objects/blob-2",
      };
      const blobC = { ...inlineBlob(), id: blobIdSchema.parse("blob-3") };
      const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
      const c1: Content = {
        ...content(first.id, [blobA.id]),
        createdAt: at(1),
        id: contentIdSchema.parse("c-1"),
        metadata: { messageId: "m1", sessionId: "s1" },
        state: "frozen",
        tag: "v1.0.0",
      };
      const c2: Content = {
        ...content(first.id),
        createdAt: at(2),
        id: contentIdSchema.parse("c-2"),
        metadata: { messageId: "m1", sessionId: "s1" },
        state: "ready",
        tag: null,
      };
      const c3: Content = {
        ...content(second.id),
        createdAt: at(3),
        id: contentIdSchema.parse("c-3"),
        metadata: { messageId: "m2", sessionId: "s2" },
        state: "failed",
        tag: "v1.0.0",
      };
      await store.commit({
        putArtifacts: [first, second],
        putBlobs: [blobC, blobA, blobB],
        putContents: [c3, c1, c2],
      });

      if (store.listBlobsPage !== undefined) {
        const page1 = await store.listBlobsPage({ limit: 2 });
        expect(page1).toEqual({
          items: [{ id: blobA.id }, { id: blobB.id, path: blobB.path }],
          nextCursor: blobB.id,
        });
        const page2 = await store.listBlobsPage({
          cursor: page1.nextCursor,
          limit: 2,
        });
        expect(page2).toEqual({ items: [{ id: blobC.id }] });
        await expect(store.listBlobsPage({ limit: 0 })).rejects.toThrow(
          RangeError
        );
      }

      if (store.listContentsPage !== undefined) {
        const page1 = await store.listContentsPage({ limit: 2 });
        expect(page1.items).toEqual([c1, c2]);
        expect(page1.nextCursor).toBe(c2.id);
        const page2 = await store.listContentsPage({
          cursor: page1.nextCursor,
          limit: 2,
        });
        expect(page2).toEqual({ items: [c3] });
        expect(
          await store.listContentsPage({ artifactId: first.id, limit: 1 })
        ).toEqual({ items: [c1], nextCursor: c1.id });
        expect(
          await store.listContentsPage({ state: ["ready", "failed"] })
        ).toEqual({ items: [c2, c3] });
        expect(await store.listContentsPage({ tagged: true })).toEqual({
          items: [c1, c3],
        });
        expect(await store.listContentsPage({ tagged: false })).toEqual({
          items: [c2],
        });
        await expect(store.listContentsPage({ limit: 0 })).rejects.toThrow(
          RangeError
        );
      }

      if (store.findContentByTag !== undefined) {
        expect(await store.findContentByTag(first.id, "v1.0.0")).toEqual(c1);
        expect(await store.findContentByTag(second.id, "v1.0.0")).toEqual(c3);
        expect(await store.findContentByTag(first.id, "v2.0.0")).toBeNull();
      }

      if (store.findContent !== undefined) {
        expect(
          await store.findContent(first.id, {
            messageId: "m1",
            sessionId: "s1",
          })
        ).toEqual(c2);
        expect(
          await store.findContent(first.id, {
            messageId: "m2",
            sessionId: "s2",
          })
        ).toBeNull();
        expect(
          await store.findContent(second.id, {
            messageId: "m2",
            sessionId: "s2",
          })
        ).toEqual(c3);
      }
    });

    it("finds the Contents and chunked blobs naming a blob", async () => {
      const store = await fresh();
      const owner = artifact();
      const leaf = inlineBlob();
      const unnamed = inlineBlob();
      const manifest: Blob = {
        byteLength: 1,
        chunks: [leaf.id],
        createdAt: AT,
        digest: OTHER_DIGEST,
        id: blobId(),
      };
      const version = content(owner.id, [leaf.id]);
      await store.commit({
        putArtifacts: [owner],
        putBlobs: [leaf, unnamed, manifest],
        putContents: [version],
      });
      expect(await store.findReferences(leaf.id)).toEqual({
        blobIds: [manifest.id],
        contentIds: [version.id],
      });
      expect(await store.findReferences(unnamed.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("replaces a record put again and removes deleted ones", async () => {
      const store = await fresh();
      const kept = artifact();
      const gone = artifact();
      const version = content(gone.id);
      const blob = inlineBlob();
      await store.commit({
        putArtifacts: [kept, gone],
        putBlobs: [blob],
        putContents: [version],
      });
      const renamed = { ...kept, name: "Renamed" };
      await store.commit({
        deleteArtifacts: [gone.id],
        deleteBlobs: [blob.id],
        deleteContents: [version.id],
        putArtifacts: [renamed],
      });
      expect(await everyArtifact(store)).toEqual([renamed]);
      expect(await store.getContent(version.id)).toBeNull();
      expect(await store.getBlob(blob.id)).toBeNull();
      expect(await store.findReferences(blob.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("applies deletes before puts", async () => {
      const store = await fresh();
      const record = artifact();
      await store.commit({ putArtifacts: [record] });
      const replaced = { ...record, name: "Replaced" };
      await store.commit({
        deleteArtifacts: [record.id],
        putArtifacts: [replaced],
      });
      expect(await store.getArtifact(record.id)).toEqual(replaced);
    });

    it("keeps no record of a write's events, with records or alone", async () => {
      const store = await fresh();
      const owner = artifact();
      const version = content(owner.id);
      await store.commit({
        events: [
          event({ artifactId: owner.id, type: "artifact.created" }),
          event({
            artifactId: owner.id,
            contentId: version.id,
            type: "artifact.written",
          }),
        ],
        putArtifacts: [owner],
        putContents: [version],
      });
      await store.commit({
        events: [removedEvent()],
      });

      expect(await everyArtifact(store)).toEqual([owner]);
      expect(await store.listContents()).toEqual([version]);
      expect(await store.listBlobs()).toEqual([]);
    });

    it("refuses whole a write whose event is not plain JSON, whatever kind of value", async () => {
      const store = await fresh();
      const base = event({
        artifactId: artifactId(),
        type: "artifact.created",
      });
      for (const value of unplainEvents()) {
        await expect(
          store.commit({
            events: [value as ArtifactEvent],
            putArtifacts: [artifact()],
          })
        ).rejects.toThrow(TypeError);
      }
      await expect(
        store.commit({ events: base as unknown as ArtifactEvent[] })
      ).rejects.toThrow("events must be an array");
      expect(await everyArtifact(store)).toEqual([]);
    });

    it.runIf(transactions)(
      "refuses such a write through a transaction's view, and the transaction goes on",
      async () => {
        const store = await fresh();
        const refused = artifact();
        const kept = artifact();
        await requireTransaction(store)(async (view) => {
          for (const value of unplainEvents()) {
            await expect(
              view.commit({
                events: [value as ArtifactEvent],
                putArtifacts: [refused],
              })
            ).rejects.toThrow(TypeError);
          }
          await view.commit({
            events: [event({ artifactId: kept.id, type: "artifact.created" })],
            putArtifacts: [kept],
          });
        });

        expect(await store.getArtifact(refused.id)).toBeNull();
        expect(await store.getArtifact(kept.id)).toEqual(kept);
      }
    );

    it("keeps nothing from a commit that fails", async () => {
      const store = await fresh();
      const before = artifact();
      await store.commit({ putArtifacts: [before] });
      const unstorable = artifact({
        metadata: { unstorable: () => undefined },
      });
      await expect(
        store.commit({
          deleteArtifacts: [before.id],
          putArtifacts: [artifact(), unstorable],
          putBlobs: [inlineBlob()],
        })
      ).rejects.toThrow();
      expect(await everyArtifact(store)).toEqual([before]);
      expect(await store.listBlobs()).toEqual([]);
    });

    it("lands a commit made after one that fails in its turn", async () => {
      const store = await fresh();
      await store
        .commit({
          putArtifacts: [artifact({ createdAt: new Date(Number.NaN) })],
        })
        .catch(() => undefined);
      const after = artifact();
      expect(
        await settlesWithin(store.commit({ putArtifacts: [after] }), 2000)
      ).toBe("resolved");
      expect(await store.getArtifact(after.id)).toEqual(after);
    });

    it.runIf(transactions)(
      "lands a commit made after a transaction whose work throws, and keeps nothing of it",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        const doomed = artifact();
        await expect(
          transaction(async (view) => {
            await view.commit({ putArtifacts: [doomed] });
            throw new Error("work failed");
          })
        ).rejects.toThrow("work failed");
        const after = artifact();
        expect(
          await settlesWithin(store.commit({ putArtifacts: [after] }), 2000)
        ).toBe("resolved");
        expect(await store.getArtifact(doomed.id)).toBeNull();
        expect(await store.getArtifact(after.id)).toEqual(after);
      }
    );

    it.runIf(transactions)(
      "lands a commit queued behind a transaction that fails, and one queued behind a failing commit",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        const entered = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const failing = transaction(async () => {
          entered.resolve(undefined);
          await release.promise;
          throw new Error("work failed");
        });
        await entered.promise;
        const queued = artifact();
        const waiting = store.commit({ putArtifacts: [queued] });
        const refused = store.commit({
          putArtifacts: [artifact({ createdAt: new Date(Number.NaN) })],
        });
        const last = artifact();
        const behind = store.commit({ putArtifacts: [last] });
        release.resolve(undefined);
        await expect(failing).rejects.toThrow("work failed");
        await refused.catch(() => undefined);
        expect(await settlesWithin(waiting, 2000)).toBe("resolved");
        expect(await settlesWithin(behind, 2000)).toBe("resolved");
        expect(await store.getArtifact(queued.id)).toEqual(queued);
        expect(await store.getArtifact(last.id)).toEqual(last);
      }
    );

    it("detaches what it stores from what it returns", async () => {
      const store = await fresh();
      const record = artifact();
      const blob = inlineBlob();
      await store.commit({ putArtifacts: [record], putBlobs: [blob] });
      (record as { name: string }).name = "Changed by the writer";
      blob.bytes?.fill(9);
      Object.assign((await store.getArtifact(record.id)) ?? {}, {
        name: "Changed by a reader",
      });
      const [listed] = await everyArtifact(store);
      (listed?.metadata as Record<string, unknown>).sessionId = "changed";
      (await store.getBlob(blob.id))?.bytes?.fill(7);

      expect((await store.getArtifact(record.id))?.name).toBe("Notes");
      expect((await store.getArtifact(record.id))?.metadata).toEqual({
        sessionId: "session",
      });
      expect((await store.getBlob(blob.id))?.bytes).toEqual(
        new Uint8Array([1])
      );
    });

    it("keeps two scopes over one storage apart", async () => {
      const storage = await open();
      const mine = storage("mine");
      const theirs = storage("theirs");
      const record = artifact();
      const blob = inlineBlob();
      await mine.commit({ putArtifacts: [record], putBlobs: [blob] });
      expect(await theirs.getArtifact(record.id)).toBeNull();
      expect(await everyArtifact(theirs)).toEqual([]);
      expect(await theirs.listBlobs()).toEqual([]);
      expect(await theirs.findBlobs(DIGEST)).toEqual([]);
      expect(await everyArtifact(storage("mine"))).toEqual([record]);
    });

    it("lists Artifacts by filter in creation order, paged by cursor", async () => {
      const store = await fresh();
      const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
      const [early, tiedLow, tiedHigh, archived, other] = [
        artifact({ createdAt: at(1), name: "Early Notes" }),
        artifact({
          createdAt: at(2),
          id: artifactIdSchema.parse("a-tied"),
          name: "Tied",
        }),
        artifact({
          createdAt: at(2),
          id: artifactIdSchema.parse("b-tied"),
          name: "Tied",
        }),
        artifact({
          archivedAt: at(3),
          createdAt: at(3),
          name: "Archived Notes",
          status: "archived",
        }),
        artifact({ createdAt: at(4), name: "Other", type: "image/png" }),
      ];
      await store.commit({
        putArtifacts: [other, archived, tiedHigh, early, tiedLow],
      });
      const listed = (query: Partial<ArtifactListQuery>) =>
        store.listArtifacts({ limit: 10, ...query });

      expectListing(await listed({}), [early, tiedLow, tiedHigh, other], 4);
      const withArchived = await listed({ includeArchived: true });
      expect(withArchived.artifacts).toHaveLength(5);
      if (exactTotal) {
        expect(withArchived.total).toBe(5);
      }
      expectListing(await listed({ type: "image/png" }), [other], 1);
      expectListing(
        await listed({ includeArchived: true, text: "NOTES" }),
        [early, archived],
        2
      );
      expect(
        (await listed({ text: tiedHigh.id.slice(0, 3) })).artifacts
      ).toEqual([tiedHigh]);
      expectListing(await listed({ limit: 2 }), [early, tiedLow], 4);
      expectListing(
        await listed({ after: { createdAt: at(2), id: tiedLow.id }, limit: 2 }),
        [tiedHigh, other],
        4
      );
      expectListing(
        await listed({ after: { createdAt: at(4), id: other.id } }),
        [],
        4
      );
    });

    it("matches text as toLowerCase does, by code unit, with % and _ as themselves", async () => {
      const store = await fresh();
      const named = (title: string, fields: Partial<Artifact> = {}) =>
        artifact({ name: title, ...fields });
      const records = {
        accented: named("ÄRGER im Büro"),
        dotted: named("İstanbul"),
        emoji: named("😀 face"),
        greek: named("ΟΔΟΣ"),
        id: named("By id", { id: artifactIdSchema.parse("ID-ÄBC") }),
        percent: named("100% done"),
        plain: named("plain"),
        type: named("By type", { type: "TEXT/Markdown" }),
        underscore: named("snake_case"),
      };
      await store.commit({ putArtifacts: Object.values(records) });
      const matching = async (text: string) => {
        const listing = await store.listArtifacts({ limit: 100, text });
        if (exactTotal) {
          expect(listing.total).toBe(listing.artifacts.length);
        }
        return listing.artifacts.map((row) => row.name).sort();
      };

      expect(await matching("ärger")).toEqual(["ÄRGER im Büro"]);
      expect(await matching("ÄRGER")).toEqual(["ÄRGER im Büro"]);
      expect(await matching("i̇stanbul")).toEqual(["İstanbul"]);
      expect(await matching("istanbul")).toEqual([]);
      expect(await matching("ς")).toEqual(["ΟΔΟΣ"]);
      expect(await matching("σ")).toEqual([]);
      expect(await matching("%")).toEqual(["100% done"]);
      expect(await matching("0% d")).toEqual(["100% done"]);
      expect(await matching("_")).toEqual(["snake_case"]);
      expect(await matching("e_c")).toEqual(["snake_case"]);
      expect(await matching("%d")).toEqual([]);
      expect(await matching("markdown")).toEqual(["By type"]);
      expect(await matching("id-äb")).toEqual(["By id"]);
      if (loneSurrogates) {
        expect(await matching("\uD83D")).toEqual(["😀 face"]);
      }
      expect(await matching("\u0000")).toEqual([]);
      expect(await matching("")).toHaveLength(Object.keys(records).length);
    });

    it("orders tied Artifacts by id in code-unit order, and pages between them", async () => {
      const store = await fresh();
      const ids = ["￿", "😀", "a", ""];
      await store.commit({
        putArtifacts: ids.map((id) =>
          artifact({ id: artifactIdSchema.parse(id), name: id })
        ),
      });
      const order = ["a", "😀", "", "￿"];
      const page = async (after?: string, limit = 10) =>
        store.listArtifacts({
          ...(after === undefined
            ? {}
            : { after: { createdAt: AT, id: artifactIdSchema.parse(after) } }),
          limit,
        });
      const names = async (after?: string, limit?: number) =>
        (await page(after, limit)).artifacts.map((row) => row.name);

      expect(await names()).toEqual(order);
      expect(await names(undefined, 2)).toEqual(order.slice(0, 2));
      expect(await names("😀")).toEqual(order.slice(2));
      if (loneSurrogates) {
        expect(await names("\uD83D")).toEqual(order.slice(1));
      }
      if (exactTotal) {
        expect((await page("")).total).toBe(4);
      }
    });

    it("counts every match of the filter, whatever the cursor and limit", async () => {
      const store = await fresh();
      const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
      const rows = [
        artifact({ createdAt: at(1), name: "Draft note" }),
        artifact({ createdAt: at(2), name: "Image note", type: "image/png" }),
        artifact({
          archivedAt: at(3),
          createdAt: at(3),
          name: "Archived note",
          status: "archived",
        }),
        artifact({
          archivedAt: at(4),
          createdAt: at(4),
          name: "Archived image",
          status: "archived",
          type: "image/png",
        }),
        artifact({ createdAt: at(5), name: "Other" }),
      ];
      await store.commit({ putArtifacts: rows });
      const [first] = rows;
      const after = { createdAt: at(1), id: first?.id as ArtifactId };
      const cases: [Partial<ArtifactListQuery>, number, number][] = [
        [{}, 3, 3],
        [{ includeArchived: true }, 5, 5],
        [{ type: "image/png" }, 1, 1],
        [{ includeArchived: true, type: "image/png" }, 2, 2],
        [{ text: "note" }, 2, 2],
        [{ includeArchived: true, text: "NOTE" }, 3, 3],
        [{ includeArchived: true, text: "image", type: "image/png" }, 2, 2],
        [{ after, includeArchived: true }, 4, 5],
        [{ after, limit: 1, text: "note" }, 1, 2],
        [{ after, includeArchived: true, limit: 1, type: "image/png" }, 1, 2],
        [{ type: "missing" }, 0, 0],
        [{ text: "missing" }, 0, 0],
      ];
      for (const [query, listed, total] of cases) {
        const listing = await store.listArtifacts({ limit: 10, ...query });
        expect(listing.artifacts.length, JSON.stringify(query)).toBe(listed);
        if (exactTotal) {
          expect(listing.total, JSON.stringify(query)).toBe(total);
        }
      }
      const [low, ...higher] = sorted(rows);
      const byId = await store.listArtifacts({
        after: { createdAt: new Date(Number.NaN), id: low?.id as ArtifactId },
        includeArchived: true,
        limit: 10,
      });
      expect(sorted(byId.artifacts)).toEqual(higher);
      if (exactTotal) {
        expect(byId.total).toBe(5);
      }
      const afterInvalid = (id: string, limit: number) =>
        store.listArtifacts({
          after: { createdAt: new Date(Number.NaN), id: id as ArtifactId },
          includeArchived: true,
          limit,
        });
      const pivot = higher[1]?.id ?? "";
      const kept = rows.filter((row) => row.id > pivot);
      expect((await afterInvalid(pivot, 10)).artifacts).toEqual(kept);
      expectListing(await afterInvalid(pivot, 1), kept.slice(0, 1), 5);
      expect((await afterInvalid("", 10)).artifacts).toEqual(rows);
    });

    it.runIf(loneSurrogates)(
      "matches text holding a lone surrogate by code unit, within one field, and bounds it by limit",
      async () => {
        const store = await fresh();
        const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
        const rows = [
          artifact({ createdAt: at(1), name: "😀 face" }),
          artifact({ createdAt: at(2), name: "😀 other" }),
          artifact({ createdAt: at(3), name: "x😀", type: "text/plain" }),
          artifact({ createdAt: at(4), name: "🙂 face" }),
          artifact({ createdAt: at(5), name: "\u0AD8\u3D00" }),
        ];
        await store.commit({ putArtifacts: rows });
        const check = async (
          text: string,
          expectedNames: readonly string[],
          expectedTotal: number,
          limit = 10
        ) => {
          const listing = await store.listArtifacts({ limit, text });
          expect(listing.artifacts.map((row) => row.name)).toEqual(
            expectedNames
          );
          if (exactTotal) {
            expect(listing.total).toBe(expectedTotal);
          }
        };

        await check("\uD83D", ["😀 face", "😀 other", "x😀", "🙂 face"], 4);
        await check("\uDE00", ["😀 face", "😀 other", "x😀"], 3);
        await check("\uDE00 f", ["😀 face"], 1);
        await check("\uDE00t", [], 0);
        await check("\uDE00 O", ["😀 other"], 1);
        await check("\uD83D", ["😀 face"], 4, 1);
        await check("\uD83D\u0000", [], 0);
      }
    );

    it("names each referencing record once, and forgets a reference put away", async () => {
      const store = await fresh();
      const owner = artifact();
      const [leaf, other, spare] = [inlineBlob(), inlineBlob(), inlineBlob()];
      const manifest: Blob = {
        byteLength: 3,
        chunks: [leaf.id, leaf.id, spare.id],
        createdAt: AT,
        digest: OTHER_DIGEST,
        id: blobId(),
      };
      const version = content(owner.id, [leaf.id, leaf.id]);
      await store.commit({
        putArtifacts: [owner],
        putBlobs: [leaf, other, spare, manifest],
        putContents: [version],
      });
      expect(await store.findReferences(leaf.id)).toEqual({
        blobIds: [manifest.id],
        contentIds: [version.id],
      });

      await store.commit({
        putBlobs: [{ ...manifest, chunks: [other.id] }],
        putContents: [{ ...version, tree: content(owner.id, [other.id]).tree }],
      });
      expect(await store.findReferences(leaf.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
      expect(await store.findReferences(spare.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
      expect(await store.findReferences(other.id)).toEqual({
        blobIds: [manifest.id],
        contentIds: [version.id],
      });

      await store.commit({
        deleteBlobs: [manifest.id],
        deleteContents: [version.id],
      });
      expect(await store.findReferences(other.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("keeps the last of one record put twice in one write", async () => {
      const store = await fresh();
      const owner = artifact();
      const [first, last] = [inlineBlob(), inlineBlob()];
      const version = content(owner.id, [first.id]);
      const again = { ...version, tree: content(owner.id, [last.id]).tree };
      await store.commit({
        putArtifacts: [owner, { ...owner, name: "Last" }],
        putBlobs: [first, last],
        putContents: [version, again],
      });
      expect((await store.getArtifact(owner.id))?.name).toBe("Last");
      expect(await store.getContent(version.id)).toEqual(again);
      expect((await store.findReferences(first.id)).contentIds).toEqual([]);
      expect((await store.findReferences(last.id)).contentIds).toEqual([
        version.id,
      ]);
    });

    it("gives every field back exactly, set or null, of every record and source", async () => {
      const store = await fresh();
      const later = new Date(AT.getTime() + 1234);
      const owner = artifact({
        archivedAt: later,
        metadata: {
          ["__proto__"]: { own: true },
          nested: { list: [1, -1.5, "two", null, true, { deep: [] }] },
          sessionId: "s",
          unicode: loneSurrogates
            ? "\u0000 and \uD800 kept in JSON"
            : "\u0000 kept in JSON",
        },
        publishedAt: later,
        status: "archived",
      });
      const bare = artifact();
      const empty: Blob = {
        byteLength: 0,
        bytes: new Uint8Array(0),
        createdAt: AT,
        digest: DIGEST,
        id: blobId(),
      };
      const backed: Blob = {
        byteLength: 2,
        createdAt: later,
        digest: OTHER_DIGEST,
        id: blobId(),
        path: "objects/ab/cd",
      };
      const leaf = inlineBlob();
      const manifest: Blob = {
        byteLength: 1,
        chunks: [leaf.id],
        createdAt: AT,
        digest: DIGEST,
        id: blobId(),
      };
      const version: Content = {
        ...content(owner.id, [backed.id]),
        frozenAt: later,
        metadata: {
          entries: { main: "0.txt" },
          entry: "0.txt",
          failure: { code: "x", message: "y" },
          unknown: { kept: [1] },
        },
        state: "frozen",
        tag: "v1",
        tree: {
          ["__proto__"]: { type: "directory" },
          "0.txt": {
            blobId: backed.id,
            bytes: 2,
            digest: OTHER_DIGEST,
            mime: "text/plain",
            type: "file",
          },
          "1.bin": {
            blobId: empty.id,
            bytes: 0,
            digest: DIGEST,
            mime: null,
            type: "file",
          },
          dev: { type: "device" },
          dir: { type: "directory" },
          link: { target: "../elsewhere", type: "symlink" },
          pipe: { type: "pipe" },
          sock: { type: "socket" },
        },
      };
      const pointed = { ...owner, contentId: version.id };
      await store.commit({
        putArtifacts: [pointed, bare],
        putBlobs: [empty, backed, leaf, manifest],
        putContents: [version],
      });

      expect(await store.getArtifact(pointed.id)).toStrictEqual(pointed);
      expect(await store.getArtifact(bare.id)).toStrictEqual(bare);
      expect(await store.getContent(version.id)).toStrictEqual(version);
      for (const blob of [empty, backed, leaf, manifest]) {
        expect(await store.getBlob(blob.id)).toStrictEqual(blob);
      }
      expect(await store.findBlobs(OTHER_DIGEST)).toStrictEqual([backed]);
      const read = await store.getContent(version.id);
      expect(Object.hasOwn(read?.tree ?? {}, "__proto__")).toBe(true);
      const owned = (await store.getArtifact(pointed.id))?.metadata;
      expect(Object.hasOwn(owned ?? {}, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(owned)).toBe(Object.prototype);
    });

    it.runIf(largeWrites)(
      "commits a tree naming thousands of blobs, and deletes tens of thousands of ids, in one write",
      async () => {
        const store = await fresh();
        const owner = artifact();
        const files = 11_000;
        const named = Array.from({ length: files }, () => blobId());
        const version = content(owner.id, named);
        await store.commit({ putArtifacts: [owner], putContents: [version] });
        expect(await store.getContent(version.id)).toEqual(version);
        expect(await store.findReferences(named[files - 1] as BlobId)).toEqual({
          blobIds: [],
          contentIds: [version.id],
        });

        const absent = 33_000;
        await store.commit({
          deleteArtifacts: Array.from({ length: absent }, () => artifactId()),
          deleteBlobs: Array.from({ length: absent }, () => blobId()),
          deleteContents: [
            ...Array.from({ length: absent }, () => contentId()),
            version.id,
          ],
        });
        expect(await store.getContent(version.id)).toBeNull();
        expect(await store.findReferences(named[0] as BlobId)).toEqual({
          blobIds: [],
          contentIds: [],
        });
        expect(await everyArtifact(store)).toEqual([owner]);
      },
      30_000
    );

    it.runIf(largeWrites)(
      "commits and deletes thousands of records in one write",
      async () => {
        const store = await fresh();
        const count = 5000;
        const owners = Array.from({ length: count }, () => artifact());
        const blobs = owners.map(() => inlineBlob());
        const versions = owners.map((owner, index) =>
          content(owner.id, [
            blobs[index]?.id as BlobId,
            blobs[0]?.id as BlobId,
          ])
        );
        await store.commit({
          putArtifacts: owners,
          putBlobs: blobs,
          putContents: versions,
        });
        const sample = await store.listArtifacts({ limit: 10 });
        expect(sample.artifacts).toHaveLength(10);
        if (exactTotal) {
          expect(sample.total).toBe(count);
        }
        expect(await store.listContents()).toHaveLength(count);
        expect(await store.listBlobs()).toHaveLength(count);
        expect(
          (await store.findReferences(blobs[0]?.id as BlobId)).contentIds
        ).toHaveLength(count);

        await store.commit({
          deleteArtifacts: owners.map((row) => row.id),
          deleteBlobs: blobs.map((row) => row.id),
          deleteContents: versions.map((row) => row.id),
        });
        expect(await everyArtifact(store)).toEqual([]);
        expect(await store.listContents()).toEqual([]);
        expect(await store.listBlobs()).toEqual([]);
        expect(await store.findReferences(blobs[0]?.id as BlobId)).toEqual({
          blobIds: [],
          contentIds: [],
        });
      },
      30_000
    );

    it.runIf(transactions)(
      "takes a write as it stands when commit is called, whatever the caller changes after",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        const owner = artifact({ metadata: { list: ["kept"] } });
        const [leaf, other] = [inlineBlob(), inlineBlob()];
        const version = content(owner.id, [leaf.id]);
        const manifest: Blob = {
          byteLength: 1,
          chunks: [leaf.id],
          createdAt: AT,
          digest: OTHER_DIGEST,
          id: blobId(),
        };
        const expected = structuredClone({ manifest, owner, version });
        const check = async (target: ArtifactStore) => {
          expect(await target.getArtifact(owner.id)).toEqual(expected.owner);
          expect(await target.getContent(version.id)).toEqual(expected.version);
          expect(await target.getBlob(manifest.id)).toEqual(expected.manifest);
          expect(await target.findReferences(leaf.id)).toEqual({
            blobIds: [manifest.id],
            contentIds: [version.id],
          });
          expect(await target.findReferences(other.id)).toEqual({
            blobIds: [],
            contentIds: [],
          });
          expect(await everyArtifact(target)).toHaveLength(1);
        };
        const writeOf = () => ({
          putArtifacts: [structuredClone(owner)],
          putBlobs: [leaf, other, structuredClone(manifest)],
          putContents: [structuredClone(version)],
        });

        const held = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const running = transaction(async () => {
          entered.resolve();
          await held.promise;
        });
        await entered.promise;
        const queued = writeOf();
        const landing = store.commit(queued);
        scramble(queued, other.id);
        held.resolve();
        await Promise.all([running, landing]);
        await check(store);

        const second = await fresh();
        await requireTransaction(second)(async (view) => {
          const through = writeOf();
          const committed = view.commit(through);
          scramble(through, other.id);
          await committed;
          await check(view);
        });
        await check(second);
      }
    );

    it("keeps a value as structuredClone takes it: no caller's toJSON runs, a getter's value stays", async () => {
      const store = await fresh();
      const hidden = { sessionId: "real" };
      Object.defineProperty(hidden, "toJSON", {
        enumerable: false,
        value: () => ({ sessionId: "changed" }),
      });
      const inherited = Object.create({
        toJSON: () => ({ sessionId: "changed" }),
      }) as Record<string, unknown>;
      inherited.sessionId = "real";
      let reads = 0;
      const getter = Object.defineProperty({}, "sessionId", {
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? "real" : "changed";
        },
      });
      const records = [hidden, inherited, getter].map((metadata) =>
        artifact({ metadata: metadata as Artifact["metadata"] })
      );
      await store.commit({ putArtifacts: records });

      for (const record of records) {
        expect((await store.getArtifact(record.id))?.metadata).toStrictEqual({
          sessionId: "real",
        });
      }
      expect(reads).toBe(1);
    });

    it.runIf(transactions)(
      "commits for good itself, and says its transaction's view does not",
      async () => {
        const store = await fresh();
        expect(store.durability ?? "commit").toBe("commit");
        const durability = await requireTransaction(store)((view) =>
          Promise.resolve(view.durability)
        );
        expect(durability).toBe("host");
      }
    );

    it("refuses a listing limit that is not a positive safe integer", async () => {
      const store = await fresh();
      await store.commit({ putArtifacts: [artifact(), artifact()] });
      for (const limit of [
        -1,
        0,
        2.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        2 ** 53,
      ]) {
        await expect(store.listArtifacts({ limit })).rejects.toThrow(
          "limit must be a positive safe integer"
        );
        if (transactions) {
          await expect(
            requireTransaction(store)((view) => view.listArtifacts({ limit }))
          ).rejects.toThrow("limit must be a positive safe integer");
        }
      }
      const full = await store.listArtifacts({
        limit: Number.MAX_SAFE_INTEGER,
      });
      expect(full.artifacts).toHaveLength(2);
      if (exactTotal) {
        expect(full.total).toBe(2);
      }
    });

    it.runIf(transactions)(
      "lists by the query as it stands when called, whatever the caller changes after",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
        const rows = [1, 2, 3].map((seconds) =>
          artifact({ createdAt: at(seconds), name: `Note ${String(seconds)}` })
        );
        await store.commit({ putArtifacts: rows });
        const [first, second] = rows;
        const held = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const running = transaction(async () => {
          entered.resolve();
          await held.promise;
        });
        await entered.promise;
        const after = { createdAt: at(1), id: first?.id as ArtifactId };
        const query = { after, limit: 1, text: "note", type: "text/plain" };
        const listing = store.listArtifacts(query);
        Object.assign(query, { limit: 10, text: "other", type: "image/png" });
        after.createdAt.setTime(0);
        held.resolve();
        await running;

        expectListing(await listing, [second as Artifact], 3);
      }
    );

    it("keeps a blob's bytes as they were at the call, even over shared memory", async () => {
      const store = await fresh();
      const outer = sharedBlob();
      const landing = store.commit({ putBlobs: [outer] });
      outer.bytes[0] = 9;
      await landing;

      const inner = sharedBlob();
      const idsToCheck: BlobId[] = [outer.id];
      if (transactions) {
        await requireTransaction(store)(async (view) => {
          const committed = view.commit({ putBlobs: [inner] });
          inner.bytes[0] = 9;
          await committed;
          expect((await view.getBlob(inner.id))?.bytes).toEqual(
            new Uint8Array([1, 2])
          );
        });
        idsToCheck.push(inner.id);
      }

      for (const id of idsToCheck) {
        const stored = await store.getBlob(id);
        expect(stored?.bytes).toEqual(new Uint8Array([1, 2]));
        if (typeof SharedArrayBuffer !== "undefined") {
          expect(stored?.bytes?.buffer).not.toBeInstanceOf(SharedArrayBuffer);
        }
      }
    });

    it("hands out bytes that share no memory with what it holds", async () => {
      const store = await fresh();
      const blob = sharedBlob();
      await store.commit({ putBlobs: [blob] });

      const [found] = await store.findBlobs(blob.digest);
      found?.bytes?.fill(7);
      (await store.getBlob(blob.id))?.bytes?.fill(8);
      if (transactions) {
        await requireTransaction(store)(async (view) => {
          (await view.getBlob(blob.id))?.bytes?.fill(6);
        });
      }
      expect((await store.getBlob(blob.id))?.bytes).toEqual(
        new Uint8Array([1, 2])
      );
    });

    it.runIf(transactions)(
      "queues a plain commit behind a running transaction",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const order: string[] = [];
        const running = transaction(async (view) => {
          entered();
          await held;
          expect(await everyArtifact(view)).toEqual([]);
          order.push("transaction ends");
        });
        await inside;
        const outside = store
          .commit({ putArtifacts: [artifact({ name: "Outside" })] })
          .then(() => order.push("outside lands"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(order).toEqual([]);
        release();
        await Promise.all([running, outside]);
        expect(order).toEqual(["transaction ends", "outside lands"]);
        expect(await everyArtifact(store)).toHaveLength(1);
      }
    );

    it.runIf(transactions)("runs transactions one at a time", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = transaction(async (view) => {
        order.push("first starts");
        await held;
        await view.commit({ putArtifacts: [artifact({ name: "First" })] });
        order.push("first commits");
      });
      const second = transaction(async (view) => {
        order.push("second starts");
        expect((await everyArtifact(view)).map((row) => row.name)).toEqual([
          "First",
        ]);
        await view.commit({ putArtifacts: [artifact({ name: "Second" })] });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(["first starts", "first commits", "second starts"]);
      expect(await everyArtifact(store)).toHaveLength(2);
    });

    it.runIf(transactions)(
      "reads a transaction's own commits through its view",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        const record = artifact();
        const blob = inlineBlob();
        await transaction(async (view) => {
          await view.commit({ putArtifacts: [record], putBlobs: [blob] });
          expect(await view.getArtifact(record.id)).toEqual(record);
          expect(await everyArtifact(view)).toEqual([record]);
          expect(await view.findBlobs(DIGEST)).toEqual([blob]);
          await view.commit({ deleteBlobs: [blob.id] });
          expect(await view.getBlob(blob.id)).toBeNull();
        });
        expect(await store.getArtifact(record.id)).toEqual(record);
        expect(await store.getBlob(blob.id)).toBeNull();
      }
    );

    it.runIf(transactions)(
      "keeps every commit made concurrently through one view",
      async () => {
        const storage = await open();
        const store = storage("conformance");
        const transaction = requireTransaction(store);
        const first = artifact({ name: "First" });
        const second = artifact({ name: "Second" });
        const named = (rows: readonly Artifact[]) =>
          rows.map((row) => row.name).sort();
        await transaction(async (view) => {
          await Promise.all([
            view.commit({ putArtifacts: [first] }),
            view.commit({ putArtifacts: [second] }),
          ]);
          expect(named(await everyArtifact(view))).toEqual(["First", "Second"]);
        });
        expect(named(await everyArtifact(store))).toEqual(["First", "Second"]);
        expect(named(await everyArtifact(storage("conformance")))).toEqual([
          "First",
          "Second",
        ]);
      }
    );

    it.runIf(transactions && reentrancyGuard)(
      "refuses a call to the outer store from inside its own transaction, at once",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        const inner = artifact({ name: "Inner" });
        const calls: Record<string, () => Promise<unknown>> = {
          commit: () => store.commit({ putArtifacts: [artifact()] }),
          transaction: () => transaction(() => Promise.resolve()),
        };
        const ended = Promise.withResolvers<void>();
        let later: Promise<unknown> = Promise.resolve();

        const refusals = await transaction(async (view) => {
          const outcomes: Record<string, string> = {};
          for (const [method, call] of Object.entries(calls)) {
            outcomes[method] = await settlesWithin(call(), 1000);
          }
          later = ended.promise.then(() =>
            store.commit({ putArtifacts: [artifact({ name: "Later" })] })
          );
          await view.commit({ putArtifacts: [inner] });
          return outcomes;
        });
        ended.resolve();

        expect(refusals).toEqual({
          commit: expect.stringMatching(REFUSAL),
          transaction: expect.stringMatching(REFUSAL),
        });
        await later;
        await store.commit({ putArtifacts: [artifact({ name: "After" })] });
        expect(
          (await everyArtifact(store)).map((row) => row.name).sort()
        ).toEqual(["After", "Inner", "Later"]);
      }
    );

    it.runIf(transactions)(
      "queues an independent caller behind a transaction it runs alongside",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        const read = Promise.withResolvers<void>();
        const proceed = Promise.withResolvers<void>();
        const running = transaction(async (view) => {
          const before = await everyArtifact(view);
          read.resolve();
          await proceed.promise;
          return { after: await everyArtifact(view), before };
        });
        await read.promise;
        const outside = store.commit({ putArtifacts: [artifact()] });
        const nested = transaction(() => Promise.resolve("queued"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        proceed.resolve();
        expect(await running).toEqual({ after: [], before: [] });
        await outside;
        expect(await nested).toBe("queued");
        expect(await everyArtifact(store)).toHaveLength(1);
      }
    );

    it.runIf(transactions)(
      "rejects a view used after its transaction settled",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        const kept = await transaction((view) => Promise.resolve(view));
        await expect(kept.listBlobs()).rejects.toThrow("settled");
        await expect(
          kept.commit({ putArtifacts: [artifact()] })
        ).rejects.toThrow("settled");
        expect(await everyArtifact(store)).toEqual([]);
      }
    );

    it.runIf(transactions)(
      "keeps none of a transaction's commits when its work throws",
      async () => {
        const store = await fresh();
        const transaction = requireTransaction(store);
        const before = artifact();
        await store.commit({ putArtifacts: [before] });
        await expect(
          transaction(async (view) => {
            await view.commit({ putArtifacts: [artifact()] });
            await view.commit({ deleteArtifacts: [before.id] });
            throw new Error("abandoned");
          })
        ).rejects.toThrow("abandoned");
        expect(await everyArtifact(store)).toEqual([before]);
      }
    );
  });
}

function describeRecordedEvents(
  name: string,
  recording: () => Promise<RecordingArtifactStores>,
  transactions: boolean
): void {
  const recorder = async () => {
    const opened = await recording();
    return { ...opened, store: opened.stores("conformance") };
  };
  const created = (owner: Artifact) =>
    event({ artifactId: owner.id, type: "artifact.created" });

  describe(`${name} Artifact store events handed to the host`, () => {
    it("hands on each commit's events once, in order, and none for a write without", async () => {
      const { recorded, store } = await recorder();
      const owner = artifact();
      const version = content(owner.id);
      const first = [
        created(owner),
        event({
          artifactId: owner.id,
          contentId: version.id,
          type: "artifact.written",
        }),
      ];
      await store.commit({
        events: first,
        putArtifacts: [owner],
        putContents: [version],
      });
      await store.commit({ putArtifacts: [{ ...owner, name: "renamed" }] });
      const gone = removedEvent();
      await store.commit({ events: [gone] });

      expect(await recorded()).toStrictEqual([...first, gone]);
    });

    it("hands on the events as they were when commit was called", async () => {
      const { recorded, store } = await recorder();
      const owner = artifact();
      const events = [created(owner)];
      const expected = structuredClone(events);

      const pending = store.commit({ events, putArtifacts: [owner] });
      Object.assign(events[0] ?? {}, { type: "artifact.removed" });
      events.push(removedEvent());
      await pending;

      expect(await recorded()).toStrictEqual(expected);
    });

    it("hands on plain JSON, and nothing of a write whose event is not", async () => {
      const { recorded, store } = await recorder();
      const owner = artifact();
      const dated = { ...created(owner), at: new Date() };

      await expect(
        store.commit({
          events: [dated as unknown as ArtifactEvent],
          putArtifacts: [owner],
        })
      ).rejects.toThrow(TypeError);
      expect(await store.getArtifact(owner.id)).toBeNull();
      expect(await recorded()).toStrictEqual([]);
    });

    it("records nothing for a write it refuses", async () => {
      const { recorded, store } = await recorder();
      const owner = artifact({ metadata: { unstorable: () => undefined } });

      await expect(
        store.commit({ events: [created(owner)], putArtifacts: [owner] })
      ).rejects.toThrow();
      expect(await recorded()).toStrictEqual([]);
    });

    it("runs the hook inside the commit: a throw from it keeps neither the write nor its events", async () => {
      const { failNextCommit, recorded, store } = await recorder();
      const owner = artifact();
      failNextCommit();

      await expect(
        store.commit({ events: [created(owner)], putArtifacts: [owner] })
      ).rejects.toThrow();
      expect(await store.getArtifact(owner.id)).toBeNull();
      expect(await recorded()).toStrictEqual([]);

      const kept = created(owner);
      await store.commit({ events: [kept], putArtifacts: [owner] });
      expect(await recorded()).toStrictEqual([kept]);
    });

    it.runIf(transactions)(
      "records a transaction's events only when it is kept",
      async () => {
        const { recorded, store } = await recorder();
        const transaction = requireTransaction(store);
        const dropped = artifact();
        const owner = artifact();
        const version = content(owner.id);
        const kept = [
          created(owner),
          event({
            artifactId: owner.id,
            contentId: version.id,
            type: "artifact.written",
          }),
        ];

        await expect(
          transaction(async (view) => {
            await view.commit({
              events: [created(dropped)],
              putArtifacts: [dropped],
            });
            throw new Error("work failed");
          })
        ).rejects.toThrow("work failed");
        await transaction(async (view) => {
          await view.commit({
            events: [kept[0] as ArtifactEvent],
            putArtifacts: [owner],
          });
          await view.commit({
            events: [kept[1] as ArtifactEvent],
            putContents: [version],
          });
        });

        expect(await recorded()).toStrictEqual(kept);
      }
    );
  });
}
