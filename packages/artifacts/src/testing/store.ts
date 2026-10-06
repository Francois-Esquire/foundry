import { describe, expect, it, vi } from "vitest";

import type {
  ArtifactOperations,
  ArtifactStore,
  ArtifactStoreTransaction,
  Content,
  StoredFile,
} from "../index";

import { ArtifactManager, StaleContentError } from "../index";

/** Run a read-only store transaction, for inspecting records in tests. */
export function readStore<T>(
  store: ArtifactStore,
  read: (store: ArtifactStoreTransaction) => Promise<T>
): Promise<T> {
  return store.transaction(read, { readOnly: true });
}

function file(content: Content): StoredFile {
  const entry = content.tree["file.txt"];
  if (entry?.type !== "file") {
    throw new Error("Expected stored file");
  }
  return entry;
}

export function describeArtifactStore(
  name: string,
  createStore: () => ArtifactStore
): void {
  describe(`${name} Artifact store conformance`, () => {
    it("preserves shared blobs through fork edits and only reclaims the final reference", async () => {
      const store = createStore();
      const artifacts = new ArtifactManager({ store });
      const original = await artifacts.create({
        entries: { "file.txt": { bytes: crypto.randomUUID() } },
        name: "Original",
        type: "text/plain",
      });
      if (!original.content) {
        throw new Error("Expected Content");
      }
      const originalBlob = file(original.content).blobId;
      const fork = await artifacts.fork({ contentId: original.content.id });
      if (!fork.content) {
        throw new Error("Expected fork Content");
      }
      expect(file(fork.content).blobId).toBe(originalBlob);
      const edited = await artifacts.write({
        artifactId: fork.id,
        changes: { put: { "file.txt": { bytes: crypto.randomUUID() } } },
      });
      const replacement = file(edited).blobId;
      expect(replacement).not.toBe(originalBlob);
      await artifacts.delete(original.id);
      expect(
        await readStore(store, (scoped) => scoped.getBlob(originalBlob))
      ).toBeNull();
      expect(
        await readStore(store, (scoped) => scoped.getBlob(replacement))
      ).not.toBeNull();
      await artifacts.delete(fork.id);
      expect(
        await readStore(store, (scoped) => scoped.getBlob(replacement))
      ).toBeNull();
    });

    it("reuses an exclusive ready blob and enforces concurrent write fences", async () => {
      const artifacts = new ArtifactManager({ store: createStore() });
      const original = await artifacts.create({
        entries: { "file.txt": { bytes: crypto.randomUUID() } },
        name: "Exclusive",
        type: "text/plain",
      });
      if (!original.content) {
        throw new Error("Expected Content");
      }
      const write = (bytes: string) =>
        artifacts.write({
          artifactId: original.id,
          changes: { put: { "file.txt": { bytes } } },
          expectedContentId: original.contentId,
          expectedUpdatedAt: original.content?.updatedAt,
        });
      const results = await Promise.allSettled([
        write(crypto.randomUUID()),
        write(crypto.randomUUID()),
      ]);
      const [first, second] = results;
      if (first.status !== "fulfilled" || second.status !== "rejected") {
        throw new Error("Expected one winner");
      }
      expect(first.value.id).toBe(original.content.id);
      expect(file(first.value).blobId).toBe(file(original.content).blobId);
      expect(second.reason).toBeInstanceOf(StaleContentError);
    });

    it("rolls back records and notifications and expires scoped handles", async () => {
      const artifacts = new ArtifactManager({ store: createStore() });
      const changed = vi.fn();
      artifacts.observe(changed);
      let scoped: ArtifactOperations | undefined;
      let id: Awaited<ReturnType<ArtifactManager["create"]>>["id"] | undefined;
      await expect(
        artifacts.transaction(async (transaction) => {
          scoped = transaction;
          ({ id } = await transaction.create({
            entries: { "file.txt": { bytes: "abort" } },
            name: "Abort",
            type: "text/plain",
          }));
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");
      if (!(id && scoped)) {
        throw new Error("Expected transaction to execute");
      }
      expect(await artifacts.get(id)).toBeNull();
      expect(changed).not.toHaveBeenCalled();
      await expect(scoped.list()).rejects.toThrow("settled");
    });

    it("refuses writes from a read-only snapshot", async () => {
      const store = createStore();
      const artifacts = new ArtifactManager({ store });
      const original = await artifacts.create({
        name: "Read-only",
        type: "text/plain",
      });
      await expect(
        store.transaction(
          async (scoped) => {
            const row = await scoped.getArtifact(original.id);
            if (!row) {
              throw new Error("Expected Artifact");
            }
            await scoped.putArtifact({ ...row, name: "Invalid update" });
          },
          { readOnly: true }
        )
      ).rejects.toThrow("read-only");
      expect((await artifacts.get(original.id))?.name).toBe("Read-only");
    });

    it("runs every required after-commit callback even when one fails", async () => {
      const store = createStore();
      const applied: string[] = [];
      await expect(
        store.transaction((scoped) => {
          scoped.afterCommit(() => {
            applied.push("first");
            return Promise.reject(new Error("application failed"));
          });
          scoped.afterCommit(() => {
            applied.push("second");
            return Promise.resolve();
          });
          return Promise.resolve();
        })
      ).rejects.toThrow("application failed");
      expect(applied).toEqual(["first", "second"]);
    });
  });
}
