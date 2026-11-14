import { describe, expect, it } from "vitest";

import { ArtifactChange } from "../change";
import type { ListArtifactsInput } from "../index";
import { ArtifactManager } from "../manager";
import { artifactIdSchema } from "../ref";
import type { Artifact, Blob } from "../schema";
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

describe("Artifact change listings", () => {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 0, 1) + seconds * 1000);
  function record(
    name: string,
    seconds: number,
    id: string = crypto.randomUUID()
  ) {
    return {
      archivedAt: null,
      contentId: null,
      createdAt: at(seconds),
      id: artifactIdSchema.parse(id),
      metadata: {},
      name,
      publishedAt: null,
      status: "draft",
      type: seconds % 2 === 0 ? "text/plain" : "image/png",
      updatedAt: at(seconds),
    } satisfies Artifact;
  }

  /** Every page of `input`, walked by cursor. */
  async function pages(change: ArtifactChange, input: ListArtifactsInput) {
    const walked: Awaited<ReturnType<ArtifactChange["listArtifacts"]>>[] = [];
    let cursor: ListArtifactsInput["cursor"];
    do {
      const page = await change.listArtifacts({ ...input, cursor });
      walked.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    return walked;
  }

  it("lists a pending change exactly as the store lists it once committed", async () => {
    const stored = [
      record("Keep first", 1),
      record("Keep tied", 2, "a-tied"),
      record("Renamed later", 2, "b-tied"),
      record("Archived later", 3),
      record("Deleted later", 4),
      record("Keep last", 5),
    ];
    const store = new InMemoryArtifactStore();
    await store.commit({ putArtifacts: stored });
    const change = new ArtifactChange(store, {});
    const [, , renamed, archived, deleted] = stored;
    await change.putArtifact({ ...required(renamed), name: "Keep renamed" });
    await change.putArtifact({
      ...required(archived),
      archivedAt: at(9),
      status: "archived",
    });
    await change.deleteArtifact(required(deleted).id);
    await change.putArtifact(record("Keep added early", 0));
    await change.putArtifact(record("Keep added tied", 2, "c-tied"));
    await change.putArtifact(record("Added last", 7));

    const committed = new InMemoryArtifactStore({
      records: await store.records(),
    });
    await committed.commit(required(change.write()));
    const after = new ArtifactChange(committed, { readOnly: true });

    for (const filter of [
      {},
      { includeArchived: true },
      { query: " keep " },
      { includeArchived: true, type: "image/png" },
    ]) {
      for (const limit of [1, 2, 3, 20]) {
        const input = { ...filter, limit };
        expect(await pages(change, input)).toEqual(await pages(after, input));
      }
    }
  });
});
