import { describe, expect, expectTypeOf, test } from "vitest";

import type { Artifacts, FileInput, FileRangeResolved } from "../index";

// biome-ignore lint/performance/noNamespaceImport: This test inspects the complete public export contract.
import * as artifacts from "../index";

describe("Artifact package public surface", () => {
  test("publishes the substrate vocabulary and nothing from the release model", () => {
    expect(artifacts).toHaveProperty("digestTree");
    expect(artifacts).toHaveProperty("contentIdSchema");
    expect(artifacts).toHaveProperty("StaleContentError");
    expect(artifacts).not.toHaveProperty("base64ToBytes");
    expect(artifacts).toHaveProperty("ArtifactSystem");
    expect(artifacts).toHaveProperty("InMemoryArtifactStore");
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
});
