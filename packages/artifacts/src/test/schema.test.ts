import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";

import { CHUNK_BYTES } from "../constants";
import { ArtifactManager } from "../manager";
import { InMemoryArtifactStore } from "../memory";
import { blobFiles } from "../node";
import { artifactRecordsSchema, artifactSchema } from "../schema";

async function storedRecords(withFiles: boolean) {
  const store = new InMemoryArtifactStore();
  let files: ReturnType<typeof blobFiles> | undefined;
  if (withFiles) {
    const root = await mkdtemp(join(tmpdir(), "artifact-schema-"));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    files = blobFiles(join(root, "blobs"));
  }
  const artifacts = new ArtifactManager({
    store,
    ...(files ? { files } : {}),
  });
  const created = await artifacts.create({
    entries: {
      assets: { type: "directory" },
      "index.html": { bytes: "<h1>Hi</h1>", mime: "text/html" },
      large: { bytes: new Uint8Array(CHUNK_BYTES + 1) },
      latest: { target: "index.html", type: "symlink" },
    },
    freeze: { tag: "v1" },
    metadata: { entry: "index.html", label: "first" },
    name: "Page",
    type: "text/html",
  });
  await artifacts.archive(created.id);
  return store.records();
}

describe("Artifact record schema", () => {
  test.each([
    ["inline and chunked blobs", false],
    ["backing-file blobs", true],
  ])("accepts the records a store holds with %s", async (_, withFiles) => {
    const records = await storedRecords(withFiles);

    expect(artifactRecordsSchema.safeParse(records).error).toBeUndefined();
    expect(records.blobs.some((blob) => blob.chunks !== undefined)).toBe(true);
    expect(
      records.blobs.some((blob) =>
        withFiles ? blob.path !== undefined : blob.bytes !== undefined
      )
    ).toBe(true);
  });

  test("refuses keys a record does not define", async () => {
    const [artifact] = (await storedRecords(false)).artifacts;

    expect(artifactSchema.safeParse({ ...artifact, extra: 1 }).success).toBe(
      false
    );
  });
});
