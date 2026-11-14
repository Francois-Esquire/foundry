import { describe, expect, it } from "vitest";

import { ArtifactChange } from "../change";
import { ArtifactManager } from "../manager";
import type { Blob } from "../schema";
import { InMemoryArtifactStore } from "../store/memory";
import { required } from "./helpers/required";

/** A store holding one Artifact with one active Content over one blob. */
async function seeded() {
  const store = new InMemoryArtifactStore();
  const artifacts = new ArtifactManager({ store });
  const created = await artifacts.create({
    entries: { "a.txt": { bytes: "a" } },
    name: "A",
    type: "text/plain",
  });
  const content = required(created.content);
  const entry = content.tree["a.txt"];
  if (entry?.type !== "file") {
    throw new Error("Expected file");
  }
  const blob = required(await store.getBlob(entry.blobId));
  return {
    artifact: required(await store.getArtifact(created.id)),
    artifacts,
    blob,
    content,
    store,
  };
}

describe("Artifact change rules", () => {
  it("refuses a pointer to another Artifact's Content", async () => {
    const { artifacts, content, store } = await seeded();
    const other = required(
      await store.getArtifact(
        (await artifacts.create({ name: "B", type: "text/plain" })).id
      )
    );
    const change = new ArtifactChange(store, {});
    await expect(
      change.putArtifact({ ...other, contentId: content.id })
    ).rejects.toThrow("own Content");
    expect(change.write()).toBeUndefined();
  });

  it("refuses Content without its Artifact", async () => {
    const { artifact, content, store } = await seeded();
    const change = new ArtifactChange(store, {});
    await change.deleteArtifact(artifact.id);
    await expect(change.putContent(content)).rejects.toThrow(
      "requires an Artifact"
    );
  });

  it("deletes an Artifact's Contents with it, including ones this change put", async () => {
    const { artifact, content, store } = await seeded();
    const change = new ArtifactChange(store, {});
    const added = { ...content, id: crypto.randomUUID() } as typeof content;
    await change.putContent(added);
    await change.deleteArtifact(artifact.id);
    const write = required(change.write());
    expect(write.deleteArtifacts).toEqual([artifact.id]);
    expect([...(write.deleteContents ?? [])].sort()).toEqual(
      [content.id, added.id].sort()
    );
    expect(write.putContents).toEqual([]);
  });

  it("refuses to delete the active Content", async () => {
    const { content, store } = await seeded();
    const change = new ArtifactChange(store, {});
    await expect(change.deleteContent(content.id)).rejects.toThrow(
      "active Content"
    );
  });

  it("refuses a backing path another blob owns", async () => {
    const { blob, store } = await seeded();
    const path = crypto.randomUUID();
    const backed = (id: string): Blob =>
      ({
        byteLength: blob.byteLength,
        createdAt: blob.createdAt,
        digest: blob.digest,
        id,
        path,
      }) as Blob;
    await store.commit({ putBlobs: [backed(crypto.randomUUID())] });
    const change = new ArtifactChange(store, {});
    await expect(change.putBlob(backed(crypto.randomUUID()))).rejects.toThrow(
      "another blob"
    );
  });

  it("reads its own writes and leaves the store alone until written", async () => {
    const { artifact, store } = await seeded();
    const change = new ArtifactChange(store, {});
    await change.putArtifact({ ...artifact, name: "Renamed" });
    expect((await change.getArtifact(artifact.id))?.name).toBe("Renamed");
    expect((await store.getArtifact(artifact.id))?.name).toBe("A");
    await store.commit(required(change.write()));
    expect((await store.getArtifact(artifact.id))?.name).toBe("Renamed");
  });

  it("rejects writes when read-only and every call once settled", async () => {
    const { artifact, store } = await seeded();
    const reading = new ArtifactChange(store, { readOnly: true });
    await expect(reading.putArtifact(artifact)).rejects.toThrow("read-only");
    reading.settle();
    await expect(reading.getArtifact(artifact.id)).rejects.toThrow("settled");
  });
});
