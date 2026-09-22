import { describe, expect, it, vi } from "vitest";

import type { Blob, StoredFile } from "../blob";
import { CHUNK_BYTES } from "../constants";
import { ArtifactApplicationError, StaleContentError } from "../errors";
import { InMemoryArtifactStore } from "../memory";
import type { Content } from "../substrate";
import { ArtifactSystem } from "../system";
import { fixture } from "./helpers/directory";
import { required } from "./helpers/required";

function file(content: Content, path = "a.txt"): StoredFile {
  const node = content.tree[path];
  if (node?.type !== "file") {
    throw new Error("Expected file");
  }
  return node;
}

describe("ArtifactSystem blob ownership", () => {
  it("updates an exclusive ready blob in place without changing Content identity", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactSystem({ store });
    const created = await artifacts.create({
      entries: { "a.txt": { bytes: "before" } },
      name: "A",
      type: "text/plain",
    });
    const before = file(required(created.content));
    const content = await artifacts.write({
      artifactId: created.id,
      changes: { put: { "a.txt": { bytes: "after" } } },
    });
    expect(content.id).toBe(created.contentId);
    expect(file(content).blobId).toBe(before.blobId);
    expect(file(content).digest).not.toBe(before.digest);
    expect(await store.listBlobs()).toHaveLength(1);
  });

  it("preserves shared bytes through edits and deletion of a fork", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactSystem({ store });
    const original = await artifacts.create({
      entries: { "a.txt": { bytes: "shared" } },
      name: "A",
      type: "text/plain",
    });
    const fork = await artifacts.fork({
      contentId: required(original.contentId),
    });
    expect(file(required(fork.content)).blobId).toBe(
      file(required(original.content)).blobId
    );
    const edited = await artifacts.write({
      artifactId: fork.id,
      changes: { put: { "a.txt": { bytes: "fork" } } },
    });
    expect(file(edited).blobId).not.toBe(
      file(required(original.content)).blobId
    );
    expect(
      new TextDecoder().decode(
        required(
          await artifacts.readFile(required(original.contentId), "a.txt")
        ).blob
      )
    ).toBe("shared");
    expect(await store.listBlobs()).toHaveLength(2);
    await artifacts.delete(fork.id);
    expect(await store.listBlobs()).toEqual([
      { id: file(required(original.content)).blobId },
    ]);
    await artifacts.delete(original.id);
    expect(await store.listBlobs()).toEqual([]);
  });

  it("retains a blob referenced by a sibling file during a multi-file write", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactSystem({ store });
    const original = await artifacts.create({
      entries: { "a.txt": { bytes: "old" } },
      name: "A",
      type: "text/plain",
    });
    const originalFile = file(required(original.content));
    const edited = await artifacts.write({
      artifactId: original.id,
      changes: {
        put: {
          "a.txt": { bytes: "new" },
          "b.txt": { blobId: originalFile.blobId },
        },
      },
    });
    expect(file(edited, "b.txt").blobId).toBe(originalFile.blobId);
    expect(file(edited).blobId).not.toBe(originalFile.blobId);
    expect(
      new TextDecoder().decode(
        required(await artifacts.readFile(edited.id, "b.txt")).blob
      )
    ).toBe("old");
  });

  it("shares streamed chunks and reads a range across chunk boundaries", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactSystem({ store });
    const first = new Uint8Array(CHUNK_BYTES).fill(1);
    const last = new Uint8Array(7).fill(2);
    async function* source() {
      yield await Promise.resolve(first);
      yield await Promise.resolve(last);
    }
    const original = await artifacts.create({
      entries: { "a.txt": { source: source() } },
      name: "A",
      type: "application/octet-stream",
    });
    const fork = await artifacts.fork({
      contentId: required(original.contentId),
    });
    await artifacts.delete(original.id);
    expect(await store.listBlobs()).toHaveLength(3);
    const range = await artifacts.readFileRange(
      required(fork.contentId),
      "a.txt",
      { end: CHUNK_BYTES + 3, start: CHUNK_BYTES - 2 }
    );
    const bytes: number[] = [];
    for await (const part of required(range).body) {
      bytes.push(...part);
    }
    expect(bytes).toEqual([1, 1, 2, 2, 2]);
    const reads = vi.spyOn(store, "getBlob");
    const tail = await artifacts.readFileRange(
      required(fork.contentId),
      "a.txt",
      { start: CHUNK_BYTES }
    );
    for await (const part of required(tail).body) {
      expect([...part]).toEqual([...last]);
    }
    expect(reads).toHaveBeenCalledTimes(2);
    await artifacts.delete(fork.id);
    expect(await store.listBlobs()).toEqual([]);
  });

  it("rejects a blob with two byte sources without persisting it", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactSystem({ store });
    const original = await artifacts.create({
      entries: { "a.txt": { bytes: "a" } },
      name: "A",
      type: "text/plain",
    });
    const blob = required(
      await store.getBlob(file(required(original.content)).blobId)
    );
    await expect(
      store.transaction((transaction) =>
        transaction.putBlob({ ...blob, path: "elsewhere" } as unknown as Blob)
      )
    ).rejects.toThrow("Invalid blob");
    expect(await store.getBlob(blob.id)).toEqual(blob);
  });
});

describe("ArtifactSystem operation boundaries", () => {
  it("rolls back records and newly published files without notifying observers", async () => {
    const { artifacts, artifact, store, root } = await fixture(
      { "a.txt": { bytes: "old" } },
      true
    );
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const before = await readdir(join(root, ".blobs"));
    const changed = vi.fn();
    artifacts.observe(changed);
    await expect(
      artifacts.transaction(async (transaction) => {
        await transaction.write({
          artifactId: artifact.id,
          changes: { put: { "a.txt": { bytes: "uncommitted" } } },
        });
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    expect(await artifacts.get(artifact.id)).toEqual(artifact);
    expect(await readdir(join(root, ".blobs"))).toEqual(before);
    expect(await store.listBlobs()).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it("rejects a stale write after another operation commits", async () => {
    const { artifacts, artifact } = await fixture({
      "a.txt": { bytes: "old" },
    });
    const command = {
      artifactId: artifact.id,
      expectedContentId: artifact.contentId,
      expectedUpdatedAt: required(artifact.content).updatedAt,
    };
    const first = artifacts.write({
      ...command,
      changes: { put: { "a.txt": { bytes: "first" } } },
    });
    const second = artifacts.write({
      ...command,
      changes: { put: { "a.txt": { bytes: "second" } } },
    });
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe("fulfilled");
    const [, rejected] = results;
    expect(rejected.status).toBe("rejected");
    if (rejected.status !== "rejected") {
      throw new Error("Expected stale rejection");
    }
    expect(rejected.reason).toBeInstanceOf(StaleContentError);
  });

  it("expires the scoped system after transaction settlement", async () => {
    const artifacts = new ArtifactSystem({
      store: new InMemoryArtifactStore(),
    });
    const scoped = await artifacts.transaction((transaction) =>
      Promise.resolve(transaction)
    );
    await expect(scoped.list()).rejects.toThrow("settled");
  });

  it("retains committed bytes after application failure and recovers the directory", async () => {
    const { artifacts, artifact, filesystem, load, root } = await fixture(
      { "a.txt": { bytes: "old" } },
      true
    );
    const { writeFile, readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const workspace = await load();
    const unbind = artifacts.bind(() =>
      Promise.reject(new Error("application unavailable"))
    );
    await expect(
      artifacts.write({
        artifactId: artifact.id,
        changes: { put: { "a.txt": { bytes: "committed" } } },
      })
    ).rejects.toMatchObject({
      committed: true,
      constructor: ArtifactApplicationError,
    });
    expect(
      new TextDecoder().decode(
        required(
          await artifacts.readFile(required(artifact.contentId), "a.txt")
        ).blob
      )
    ).toBe("committed");
    unbind();
    await writeFile(join(workspace.root, "a.txt"), "incomplete application");
    await filesystem.recover();
    expect(await readFile(join(workspace.root, "a.txt"), "utf8")).toBe(
      "committed"
    );
    expect(await readdir(join(root, ".blobs"))).toHaveLength(1);
  });
});
