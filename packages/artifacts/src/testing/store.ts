import { describe, expect, it } from "vitest";

import type { ArtifactId, BlobId, ContentId } from "../ref";
import { artifactIdSchema, blobIdSchema, contentIdSchema } from "../ref";
import type { Artifact, Blob, Content } from "../schema";
import type { ArtifactListQuery, ArtifactStore } from "../store";
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

function inlineBlob(digest = DIGEST): Blob {
  return {
    byteLength: 1,
    bytes: new Uint8Array([1]),
    createdAt: AT,
    digest,
    id: blobId(),
  };
}

/** The store's `transaction`, bound; every Artifact store offers one. */
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

/**
 * Registers the tests every `ArtifactStore` must pass. `open` returns fresh,
 * empty storage, opened per scope: two scopes over one storage never see
 * each other's records, and one scope opened twice sees one set.
 */
export function describeArtifactStore(
  name: string,
  open: () => (scope: string) => ArtifactStore
): void {
  const fresh = () => open()("conformance");
  /** Every Artifact, oldest first. */
  const everyArtifact = async (store: ArtifactStore) =>
    (await store.listArtifacts({ includeArchived: true, limit: 1000 }))
      .artifacts;
  describe(`${name} Artifact store conformance`, () => {
    it("reads back every record a commit puts", async () => {
      const store = fresh();
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
      const store = fresh();
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

    it("lists one Artifact's Contents apart from another's", async () => {
      const store = fresh();
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
      const store = fresh();
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
      expect(sorted(await store.listBlobs())).toEqual(
        sorted([{ id: inline.id }, { id: backed.id, path: backed.path }])
      );
    });

    it("finds the Contents and chunked blobs naming a blob", async () => {
      const store = fresh();
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
      const store = fresh();
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
      const store = fresh();
      const record = artifact();
      await store.commit({ putArtifacts: [record] });
      const replaced = { ...record, name: "Replaced" };
      await store.commit({
        deleteArtifacts: [record.id],
        putArtifacts: [replaced],
      });
      expect(await store.getArtifact(record.id)).toEqual(replaced);
    });

    it("keeps nothing from a commit that fails", async () => {
      const store = fresh();
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

    it("detaches what it stores from what it returns", async () => {
      const store = fresh();
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
      const storage = open();
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
      const store = fresh();
      const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
      // Two share an instant, so ids break the tie.
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
      // Committed out of order: the listing orders them, not the commit.
      await store.commit({
        putArtifacts: [other, archived, tiedHigh, early, tiedLow],
      });
      const listed = (query: Partial<ArtifactListQuery>) =>
        store.listArtifacts({ limit: 10, ...query });

      expect(await listed({})).toEqual({
        artifacts: [early, tiedLow, tiedHigh, other],
        total: 4,
      });
      expect((await listed({ includeArchived: true })).total).toBe(5);
      expect(await listed({ type: "image/png" })).toEqual({
        artifacts: [other],
        total: 1,
      });
      expect(await listed({ includeArchived: true, text: "NOTES" })).toEqual({
        artifacts: [early, archived],
        total: 2,
      });
      expect(
        (await listed({ text: tiedHigh.id.slice(0, 3) })).artifacts
      ).toEqual([tiedHigh]);
      expect(await listed({ limit: 2 })).toEqual({
        artifacts: [early, tiedLow],
        total: 4,
      });
      expect(
        await listed({ after: { createdAt: at(2), id: tiedLow.id }, limit: 2 })
      ).toEqual({ artifacts: [tiedHigh, other], total: 4 });
      expect(
        await listed({ after: { createdAt: at(4), id: other.id } })
      ).toEqual({ artifacts: [], total: 4 });
    });

    it("queues a plain commit behind a running transaction", async () => {
      const store = fresh();
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
    });

    it("runs transactions one at a time", async () => {
      const store = fresh();
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

    it("reads a transaction's own commits through its view", async () => {
      const store = fresh();
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
    });

    it("keeps none of a transaction's commits when its work throws", async () => {
      const store = fresh();
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
    });
  });
}
