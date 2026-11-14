import { describe, expect, it } from "vitest";

import type { ArtifactId, BlobId, ContentId } from "../ref";
import { artifactIdSchema, blobIdSchema, contentIdSchema } from "../ref";
import type { Artifact, Blob, Content } from "../schema";
import type { ArtifactStore } from "../store";

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

function sorted<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Registers the tests every `ArtifactStore` must pass. `open` returns a
 * fresh, empty store each time.
 */
export function describeArtifactStore(
  name: string,
  open: () => ArtifactStore | Promise<ArtifactStore>
): void {
  describe(`${name} Artifact store conformance`, () => {
    it("reads back every record a commit puts", async () => {
      const store = await open();
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
      expect(await store.listArtifacts()).toEqual([owner]);
      expect(await store.listContents()).toEqual([version]);
      expect(await store.listContents(owner.id)).toEqual([version]);
      expect(await store.listBlobs()).toEqual([{ id: blob.id }]);
      expect(await store.findBlobs(DIGEST)).toEqual([blob]);
    });

    it("answers absent records with null and empty lists", async () => {
      const store = await open();
      expect(await store.getArtifact(artifactId())).toBeNull();
      expect(await store.getContent(contentId())).toBeNull();
      expect(await store.getBlob(blobId())).toBeNull();
      expect(await store.listArtifacts()).toEqual([]);
      expect(await store.listContents()).toEqual([]);
      expect(await store.listBlobs()).toEqual([]);
      expect(await store.findBlobs(DIGEST)).toEqual([]);
      expect(await store.findReferences(blobId())).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("lists one Artifact's Contents apart from another's", async () => {
      const store = await open();
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
      const store = await open();
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
      const store = await open();
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
      const store = await open();
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
      expect(await store.listArtifacts()).toEqual([renamed]);
      expect(await store.getContent(version.id)).toBeNull();
      expect(await store.getBlob(blob.id)).toBeNull();
      expect(await store.findReferences(blob.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("applies deletes before puts", async () => {
      const store = await open();
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
      const store = await open();
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
      expect(await store.listArtifacts()).toEqual([before]);
      expect(await store.listBlobs()).toEqual([]);
    });

    it("detaches what it stores from what it returns", async () => {
      const store = await open();
      const record = artifact();
      const blob = inlineBlob();
      await store.commit({ putArtifacts: [record], putBlobs: [blob] });
      (record as { name: string }).name = "Changed by the writer";
      blob.bytes?.fill(9);
      Object.assign((await store.getArtifact(record.id)) ?? {}, {
        name: "Changed by a reader",
      });
      const [listed] = await store.listArtifacts();
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

    it("runs transactions one at a time, committing through the view", async () => {
      const store = await open();
      const { transaction } = store;
      if (transaction === undefined) {
        return;
      }
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = transaction.call(store, async (view) => {
        order.push("first starts");
        await held;
        await view.commit({ putArtifacts: [artifact({ name: "First" })] });
        order.push("first commits");
      });
      const second = transaction.call(store, async (view) => {
        order.push("second starts");
        expect((await view.listArtifacts()).map((row) => row.name)).toEqual([
          "First",
        ]);
        await view.commit({ putArtifacts: [artifact({ name: "Second" })] });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(["first starts", "first commits", "second starts"]);
      expect(await store.listArtifacts()).toHaveLength(2);
    });

    it("keeps nothing from a transaction whose work fails before committing", async () => {
      const store = await open();
      const { transaction } = store;
      if (transaction === undefined) {
        return;
      }
      await expect(
        transaction.call(store, () => Promise.reject(new Error("abandoned")))
      ).rejects.toThrow("abandoned");
      expect(await store.listArtifacts()).toEqual([]);
    });
  });
}
