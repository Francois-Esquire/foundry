import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileNode, StorageNode } from "@foundry/core/storage";
import { describe, expect, expectTypeOf, onTestFinished, test } from "vitest";

import { CHUNK_BYTES } from "../constants";
import { ArtifactManager } from "../manager";
import { InMemoryArtifactStore } from "../memory";
import { blobFiles } from "../node";
import type { BlobId } from "../ref";
import type { ContentTree, StoredFile } from "../schema";
import {
  artifactMetadataSchema,
  artifactRecordsSchema,
  artifactSchema,
  contentMetadataSchema,
  contentTreeSchema,
} from "../schema";

/** `fields` plus an own, enumerable `__proto__` property holding `value`. */
function withOwnProto<T extends object>(fields: T, value: unknown): T {
  return Object.defineProperty({ ...fields }, "__proto__", {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function ownProto(value: object | undefined): unknown {
  if (value === undefined || !Object.hasOwn(value, "__proto__")) {
    throw new Error("Expected an own __proto__ property");
  }
  return Object.getOwnPropertyDescriptor(value, "__proto__")?.value;
}

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

  test("keeps failure fields beyond code and message", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
    const created = await artifacts.create({
      entries: { "a.txt": { bytes: "a" } },
      name: "A",
      type: "text/plain",
    });
    const contentId = created.content?.id;
    if (contentId === undefined) {
      throw new Error("Expected Content");
    }
    const failure = { code: "failed", message: "why", retryAfter: 30 };
    await artifacts.setMetadata(contentId, { failure });

    const records = await store.records();
    const [content] = artifactRecordsSchema.parse(records).contents;

    expect(content?.metadata.failure).toStrictEqual(failure);
  });

  test("returns own __proto__ keys the store keeps", async () => {
    const store = new InMemoryArtifactStore();
    const artifacts = new ArtifactManager({ store });
    const created = await artifacts.create({
      entries: withOwnProto(
        { "index.html": { bytes: "<h1>Hi</h1>", mime: "text/html" } },
        { type: "directory" }
      ),
      metadata: withOwnProto(
        {
          entries: withOwnProto({ home: "index.html" }, "index.html"),
          entry: "index.html",
        },
        { nested: true }
      ),
      name: "Page",
      type: "text/html",
    });
    const contentId = created.content?.id;
    if (contentId === undefined) {
      throw new Error("Expected Content");
    }
    await artifacts.setMetadata(contentId, {
      failure: withOwnProto(
        { code: "failed", message: "why", retryAfter: 30 },
        "cause"
      ),
    });
    await artifacts.patchArtifactMetadata(
      created.id,
      withOwnProto({ sessionId: "s" }, 1)
    );
    const records = await store.records();
    const [stored] = records.contents;
    // The store keeps every own __proto__ key; the schema must return them.
    expect(ownProto(stored?.tree)).toStrictEqual({ type: "directory" });

    const parsed = artifactRecordsSchema.parse(records);

    expect(parsed).toStrictEqual(records);
    const [artifact] = parsed.artifacts;
    const [content] = parsed.contents;
    expect(ownProto(artifact?.metadata)).toBe(1);
    expect(ownProto(content?.metadata)).toStrictEqual({ nested: true });
    expect(ownProto(content?.metadata.entries)).toBe("index.html");
    expect(ownProto(content?.metadata.failure)).toBe("cause");
    expect(content?.metadata.failure).toMatchObject({ retryAfter: 30 });
    expect(ownProto(content?.tree)).toStrictEqual({ type: "directory" });
  });

  test("accepts a tree without a prototype, as the manager builds them", () => {
    const tree = Object.assign(Object.create(null) as object, {
      assets: { type: "directory" },
    });

    expect(contentTreeSchema.parse(tree)).toBe(tree);
  });

  test("checks an own __proto__ entry like any other", () => {
    expect(
      contentTreeSchema.safeParse(withOwnProto({}, { type: "bogus" })).success
    ).toBe(false);
    expect(
      contentMetadataSchema.safeParse({ entries: withOwnProto({}, 1) }).success
    ).toBe(false);
  });

  test.each([
    ["a path that escapes the root", { "../escape": { type: "directory" } }],
    ["an empty path", { "": { type: "directory" } }],
    ["an empty symlink target", { link: { target: "", type: "symlink" } }],
    [
      "a symlink target with NUL",
      { link: { target: "a\0b", type: "symlink" } },
    ],
  ])("refuses a tree with %s", (_, tree) => {
    expect(contentTreeSchema.safeParse(tree).success).toBe(false);
  });

  test.each([
    ["a bigint", 1n],
    ["a Date", new Date(0)],
    ["undefined", undefined],
    ["a non-finite number", Number.POSITIVE_INFINITY],
  ])("refuses metadata holding %s", (_, value) => {
    expect(artifactMetadataSchema.safeParse({ value }).success).toBe(false);
    expect(contentMetadataSchema.safeParse({ value }).success).toBe(false);
    expect(
      contentMetadataSchema.safeParse({
        failure: { code: "failed", message: "why", value },
      }).success
    ).toBe(false);
  });

  test.each([
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["an array", []],
    ["null", null],
  ])("refuses %s as metadata", (_, value) => {
    expect(artifactMetadataSchema.safeParse(value).success).toBe(false);
    expect(contentMetadataSchema.safeParse(value).success).toBe(false);
  });

  test("refuses non-plain objects nested in metadata", () => {
    const dated = Object.assign(new Date(0), { code: "x", message: "y" });

    expect(contentMetadataSchema.safeParse({ failure: dated }).success).toBe(
      false
    );
    expect(
      contentMetadataSchema.safeParse({ label: { at: new Date(0) } }).success
    ).toBe(false);
    expect(artifactMetadataSchema.safeParse({ owner: new Map() }).success).toBe(
      false
    );
  });

  test("restates Core's storage nodes exactly", () => {
    expectTypeOf<Omit<StoredFile, "blobId">>().toEqualTypeOf<FileNode>();
    expectTypeOf<StoredFile["blobId"]>().toEqualTypeOf<BlobId>();
    expectTypeOf<Exclude<ContentTree[string], StoredFile>>().toEqualTypeOf<
      Exclude<StorageNode, FileNode>
    >();
  });
});
