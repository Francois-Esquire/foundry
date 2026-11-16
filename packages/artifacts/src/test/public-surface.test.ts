import { describe, expect, expectTypeOf, test } from "vitest";
import manifest from "../../package.json" with { type: "json" };
import type { BlobFiles, BlobStagingArea } from "../blob";
import type { ByteInput, ReferenceInput } from "../blob-repository";
import { BlobRepository, isReferenceInput } from "../blob-repository";
import { ArtifactChange } from "../change";
import type { Artifacts, FileInput, FileRangeResolved } from "../index";
// biome-ignore lint/performance/noNamespaceImport: This test inspects the complete public export contract.
import * as artifacts from "../index";
import { blobFiles } from "../node";
import type { ArtifactStore, ArtifactStoreWrite } from "../store";
import { InMemoryArtifactStore } from "../store/memory";
import type { SqliteArtifactStore } from "../store/sqlite";
import { ArtifactTransaction, operationEffects } from "../transaction";

describe("Artifact package public surface", () => {
  test("publishes the substrate vocabulary and nothing from the release model", () => {
    expect(artifacts).toHaveProperty("digestTree");
    expect(artifacts).toHaveProperty("contentIdSchema");
    expect(artifacts).toHaveProperty("StaleContentError");
    expect(artifacts).not.toHaveProperty("base64ToBytes");
    expect(artifacts).toHaveProperty("ArtifactManager");
    expect(artifacts).not.toHaveProperty("InMemoryArtifactStore");
    expect(artifacts).toHaveProperty("blobIdSchema");
    expect(artifacts).not.toHaveProperty("artifactFileSystem");
    expect(artifacts).not.toHaveProperty("digestReleaseEnvelope");
    expect(artifacts).not.toHaveProperty("ArtifactCheckpointSystem");
    expect(artifacts).not.toHaveProperty("MODULE_MIME");
  });

  test("carries the additive streamed-store and ranged-read vocabulary in byte terms", () => {
    // The stream variant is a source of bytes with an optional declared length —
    // no chunk/leaf/manifest vocabulary crosses the contract.
    expectTypeOf<{
      readonly source: AsyncIterable<Uint8Array>;
      readonly bytes?: number;
      readonly mime?: string | null;
    }>().toExtend<FileInput>();
    expectTypeOf<FileRangeResolved>().toExtend<{
      readonly range: { readonly start: number; readonly end: number };
      readonly body: AsyncIterable<Uint8Array>;
    }>();
    expectTypeOf<Artifacts["readFileRange"]>().toBeFunction();
  });

  test("keeps stores and test doubles on their own paths, apart from the domain", async () => {
    const exported = async (path: string) =>
      Object.keys((await import(path)) as object).sort();
    expect(await exported("../store")).toEqual([]);
    expect(await exported("../store/memory")).toEqual([
      "InMemoryArtifactStore",
    ]);
    expect(await exported("../store/sqlite")).toEqual(["SqliteArtifactStore"]);
    expect(await exported("../store/tables")).toEqual([
      "artifactBlobChunks",
      "artifactBlobs",
      "artifactContentBlobs",
      "artifactContents",
      "artifacts",
    ]);
    expect(artifacts).not.toHaveProperty("SqliteArtifactStore");
    expect(artifacts).not.toHaveProperty("artifactContents");
    expect(await exported("../testing/store")).toEqual([
      "describeArtifactStore",
    ]);
    expect(await exported("../testing")).toEqual(["interceptCommits"]);
    expectTypeOf<ArtifactStore["commit"]>()
      .parameter(0)
      .toEqualTypeOf<ArtifactStoreWrite>();
    expectTypeOf<InMemoryArtifactStore>().toExtend<ArtifactStore>();
    expectTypeOf<SqliteArtifactStore>().toExtend<ArtifactStore>();
  });

  test("declares each store and suite path explicitly", () => {
    const { exports } = manifest as { exports: Record<string, unknown> };
    for (const [path, file] of [
      ["./store", "store/index"],
      ["./store/memory", "store/memory"],
      ["./store/sqlite", "store/sqlite"],
      ["./store/tables", "store/tables"],
      ["./testing", "testing/index"],
      ["./testing/store", "testing/store"],
      ["./testing/manager", "testing/manager"],
    ]) {
      expect(exports[path as string]).toMatchObject({
        import: `./src/${file}.ts`,
      });
    }
  });

  test("keeps what consumers import from the blob-repository and transaction subpaths", async () => {
    expectTypeOf<ByteInput>().toExtend<FileInput>();
    expectTypeOf<ReferenceInput>().toExtend<FileInput>();
    expect(isReferenceInput({ blobId: "b" } as FileInput)).toBe(true);
    expect(isReferenceInput({ bytes: "x" })).toBe(false);
    const change = new ArtifactChange(new InMemoryArtifactStore(), {});
    const limits = { maxFileBytes: 64, maxTreeBytes: 64 };
    const transaction = new ArtifactTransaction(
      change,
      operationEffects(),
      limits
    );
    const repository = new BlobRepository(change, operationEffects(), limits);
    expect(repository.files).toBeUndefined();
    const written = await repository.write("b.txt", { bytes: "b" });
    expect(written.byteLength).toBe(1);
    const created = await transaction.create({
      entries: { "a.txt": { bytes: "a" } },
      name: "A",
      type: "text/plain",
    });
    expect(created.content?.tree["a.txt"]).toMatchObject({ type: "file" });
  });

  test("offers staging as an optional BlobFiles capability", () => {
    expectTypeOf<BlobFiles["staging"]>().toEqualTypeOf<
      BlobStagingArea | undefined
    >();
    expectTypeOf<Omit<BlobFiles, "staging">>().toExtend<BlobFiles>();
    expect(blobFiles("/nonexistent/root").staging).toMatchObject({
      abandon: expect.any(Function),
      discard: expect.any(Function),
      promote: expect.any(Function),
      stage: expect.any(Function),
    });
  });
});
