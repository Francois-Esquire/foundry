import { describe, expect, it, vi } from "vitest";

import type { Blob, StoredFile } from "../blob";
import { CHUNK_BYTES } from "../constants";
import { ArtifactApplicationError, StaleContentError } from "../errors";
import { ArtifactManager } from "../manager";
import { InMemoryArtifactStore } from "../memory";
import type { Content } from "../substrate";
import { readStore } from "../testing/store";
import { fixture } from "./helpers/directory";
import { required } from "./helpers/required";

function file(content: Content, path = "a.txt"): StoredFile {
  const node = content.tree[path];
  if (node?.type !== "file") {
    throw new Error("Expected file");
  }
  return node;
}

describe("ArtifactManager blob objects", () => {
  it("updates an exclusive ready blob in place without changing Content identity", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
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
    expect(await readStore(store, (scoped) => scoped.listBlobs())).toHaveLength(
      1
    );
  });

  it("preserves shared bytes through edits and deletion of a fork", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
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
    expect(await readStore(store, (scoped) => scoped.listBlobs())).toHaveLength(
      2
    );
    await artifacts.delete(fork.id);
    expect(await readStore(store, (scoped) => scoped.listBlobs())).toEqual([
      { id: file(required(original.content)).blobId },
    ]);
    await artifacts.delete(original.id);
    expect(await readStore(store, (scoped) => scoped.listBlobs())).toEqual([]);
  });

  it("retains a blob referenced by a sibling file during a multi-file write", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
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
    const artifacts = new ArtifactManager({ store });
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
    expect(await readStore(store, (scoped) => scoped.listBlobs())).toHaveLength(
      3
    );
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
    const reads = vi.spyOn(store, "transaction");
    const tail = await artifacts.readFileRange(
      required(fork.contentId),
      "a.txt",
      { start: CHUNK_BYTES }
    );
    for await (const part of required(tail).body) {
      expect([...part]).toEqual([...last]);
    }
    // One read locates the file; the tail pulls only its own chunk.
    expect(reads).toHaveBeenCalledTimes(2);
    await artifacts.delete(fork.id);
    expect(await readStore(store, (scoped) => scoped.listBlobs())).toEqual([]);
  });

  it("rewrites an owned object in place even when another object holds the new bytes", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
    const other = await artifacts.create({
      entries: { "a.txt": { bytes: "target" } },
      name: "Other",
      type: "text/plain",
    });
    const owner = await artifacts.create({
      entries: { "a.txt": { bytes: "before" } },
      name: "Owner",
      type: "text/plain",
    });
    const owned = file(required(owner.content)).blobId;
    const edited = await artifacts.write({
      artifactId: owner.id,
      changes: { put: { "a.txt": { bytes: "target" } } },
    });
    expect(file(edited).blobId).toBe(owned);
    expect(file(edited).blobId).not.toBe(file(required(other.content)).blobId);
    expect(await readStore(store, (scoped) => scoped.listBlobs())).toHaveLength(
      2
    );
  });

  it("does not rewrite an object a sibling byte write joined in the same change", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
    const original = await artifacts.create({
      entries: { "a.txt": { bytes: "old" } },
      name: "A",
      type: "text/plain",
    });
    // b.txt joins a.txt's object before a.txt is written.
    const put = Object.fromEntries([
      ["b.txt", { bytes: "old" }],
      ["a.txt", { bytes: "new" }],
    ]);
    const edited = await artifacts.write({
      artifactId: original.id,
      changes: { put },
    });
    const read = async (path: string) =>
      new TextDecoder().decode(
        required(await artifacts.readFile(edited.id, path)).blob
      );
    expect(await read("a.txt")).toBe("new");
    expect(await read("b.txt")).toBe("old");
    expect(file(edited, "b.txt").blobId).toBe(
      file(required(original.content)).blobId
    );
  });

  it("chunks large in-memory bytes like a stream and shares the result", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
    const bytes = new Uint8Array(CHUNK_BYTES + 5).fill(3);
    async function* stream() {
      yield await Promise.resolve(bytes.subarray(0, 10));
      yield await Promise.resolve(bytes.subarray(10));
    }
    const fromBytes = await artifacts.create({
      entries: { "a.bin": { bytes } },
      name: "Bytes",
      type: "application/octet-stream",
    });
    const fromStream = await artifacts.create({
      entries: { "a.bin": { source: stream() } },
      name: "Stream",
      type: "application/octet-stream",
    });
    const { blobId } = file(required(fromBytes.content), "a.bin");
    expect(file(required(fromStream.content), "a.bin").blobId).toBe(blobId);
    expect(
      (await readStore(store, (scoped) => scoped.getBlob(blobId)))?.chunks
    ).toHaveLength(2);
    expect(await readStore(store, (scoped) => scoped.listBlobs())).toHaveLength(
      3
    );
  });

  it("retires the previous backing file of a rewritten object after commit", async () => {
    const { artifacts, artifact, root } = await fixture(
      { "a.txt": { bytes: "old" } },
      true
    );
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const before = await readdir(join(root, ".blobs"));
    const edited = await artifacts.write({
      artifactId: artifact.id,
      changes: { put: { "a.txt": { bytes: "new" } } },
    });
    const after = await readdir(join(root, ".blobs"));
    expect(file(edited).blobId).toBe(file(required(artifact.content)).blobId);
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
  });

  it("rejects a blob with two byte sources without persisting it", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
    const original = await artifacts.create({
      entries: { "a.txt": { bytes: "a" } },
      name: "A",
      type: "text/plain",
    });
    const blob = required(
      await readStore(store, (scoped) =>
        scoped.getBlob(file(required(original.content)).blobId)
      )
    );
    await expect(
      store.transaction((transaction) =>
        transaction.putBlob({ ...blob, path: "elsewhere" } as unknown as Blob)
      )
    ).rejects.toThrow("Invalid blob");
    expect(await readStore(store, (scoped) => scoped.getBlob(blob.id))).toEqual(
      blob
    );
  });
});

describe("ArtifactManager operation boundaries", () => {
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
    expect(await readStore(store, (scoped) => scoped.listBlobs())).toHaveLength(
      1
    );
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

  it("publishes only on explicit freeze, not on the freezes revise and fork imply", async () => {
    const artifacts = new ArtifactManager({
      store: new InMemoryArtifactStore(),
    });
    const create = (name: string) =>
      artifacts.create({
        entries: { "a.txt": { bytes: name } },
        name,
        type: "text/plain",
      });
    const revised = await create("Revised");
    const source = required(revised.content);
    await artifacts.revise({
      artifactId: revised.id,
      contentId: source.id,
      expectedUpdatedAt: source.updatedAt,
    });
    const forked = await create("Forked");
    await artifacts.fork({ contentId: required(forked.contentId) });
    const frozen = await create("Frozen");
    await artifacts.freeze(required(frozen.contentId));
    for (const { id, contentId } of [revised, forked]) {
      expect((await artifacts.getContent(required(contentId)))?.state).toBe(
        "frozen"
      );
      expect(await artifacts.get(id)).toMatchObject({
        publishedAt: null,
        status: "draft",
      });
    }
    expect((await artifacts.get(frozen.id))?.status).toBe("published");
  });

  it("expires the transaction handle after settlement", async () => {
    const artifacts = new ArtifactManager({
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
