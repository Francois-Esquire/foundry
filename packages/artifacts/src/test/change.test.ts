import { describe, expect, it } from "vitest";
import { Artifacts } from "../artifacts";
import { ArtifactChange } from "../change";
import { artifactIdSchema } from "../ids";
import type { ListArtifactsInput } from "../index";
import type { Artifact, Blob } from "../schema";
import { required } from "./helpers/required";
import { openStore, STORE_KINDS, type StoreKind } from "./helpers/stores";

async function seeded(kind: StoreKind) {
  const store = await openStore(kind);
  const artifacts = new Artifacts({ store });
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

describe.each(STORE_KINDS)("%s store: Artifact change rules", (kind) => {
  it("refuses a pointer to another Artifact's Content", async () => {
    const { artifacts, content, store } = await seeded(kind);
    const other = required(
      await store.getArtifact(
        (await artifacts.create({ name: "B", type: "text/plain" })).id
      )
    );
    const change = ArtifactChange.begin(store, {});
    await expect(
      change.putArtifact({ ...other, contentId: content.id })
    ).rejects.toThrow("own Content");
    expect(change.write()).toBeUndefined();
  });

  it("refuses Content without its Artifact", async () => {
    const { artifact, content, store } = await seeded(kind);
    const change = ArtifactChange.begin(store, {});
    await change.deleteArtifact(artifact.id);
    await expect(change.putContent(content)).rejects.toThrow(
      "requires an Artifact"
    );
  });

  it("deletes an Artifact's Contents with it, including ones this change put", async () => {
    const { artifact, content, store } = await seeded(kind);
    const change = ArtifactChange.begin(store, {});
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
    const { content, store } = await seeded(kind);
    const change = ArtifactChange.begin(store, {});
    await expect(change.deleteContent(content.id)).rejects.toThrow(
      "active Content"
    );
  });

  it("refuses a backing path another blob owns", async () => {
    const { blob, store } = await seeded(kind);
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
    const change = ArtifactChange.begin(store, {});
    await expect(change.putBlob(backed(crypto.randomUUID()))).rejects.toThrow(
      "another blob"
    );
  });

  it("reads its own writes and leaves the store alone until written", async () => {
    const { artifact, store } = await seeded(kind);
    const change = ArtifactChange.begin(store, {});
    await change.putArtifact({ ...artifact, name: "Renamed" });
    expect((await change.getArtifact(artifact.id))?.name).toBe("Renamed");
    expect((await store.getArtifact(artifact.id))?.name).toBe("A");
    await store.commit(required(change.write()));
    expect((await store.getArtifact(artifact.id))?.name).toBe("Renamed");
  });

  it("rejects writes when read-only and every call once settled", async () => {
    const { artifact, store } = await seeded(kind);
    const reading = ArtifactChange.begin(store, { readOnly: true });
    await expect(reading.putArtifact(artifact)).rejects.toThrow("read-only");
    reading.settle();
    await expect(reading.getArtifact(artifact.id)).rejects.toThrow("settled");
  });

  it("finds another stored Content sharing a tag when the first match is excluded or shadowed", async () => {
    const { artifact, content, store } = await seeded(kind);
    const first = { ...content, tag: "v1" };
    const second = {
      ...content,
      id: crypto.randomUUID() as typeof content.id,
      tag: "v1",
    };
    await store.commit({ putContents: [first, second] });

    const firstMatched = required(
      await store.findContentByTag?.(artifact.id, "v1")
    );
    const other = firstMatched.id === first.id ? second : first;

    const excluding = ArtifactChange.begin(store, { readOnly: true });
    expect(
      (await excluding.findContentByTag(artifact.id, "v1", firstMatched.id))?.id
    ).toBe(other.id);

    const shadowing = ArtifactChange.begin(store, {});
    await shadowing.putContent({ ...firstMatched, tag: null });
    expect((await shadowing.findContentByTag(artifact.id, "v1"))?.id).toBe(
      other.id
    );
  });
});

describe.each(STORE_KINDS)("%s store: Artifact change listings", (kind) => {
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
    const store = await openStore(kind);
    await store.commit({ putArtifacts: stored });
    const change = ArtifactChange.begin(store, {});
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

    const committed = await openStore(kind);
    await committed.commit({ putArtifacts: stored });
    await committed.commit(required(change.write()));
    const after = ArtifactChange.begin(committed, { readOnly: true });

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
