/**
 * Caller-owned instrument. Nothing here runs without a token, and nothing here
 * is a gate: it closes the one Replicate claim this Step could not source from
 * an installed declaration — the image row's output MIME, which comes from the
 * model's documented default output format rather than from the adapter.
 *
 *   REPLICATE_API_TOKEN=… bun run --cwd=packages/models test -- replicate-vendor
 */
import { describe, expect, it } from "vitest";

import { operationsOf } from "../provider";
import { REPLICATE_DEFAULT_MODELS, replicateProvider } from "../replicate";

// eslint-disable-next-line turbo/no-undeclared-env-vars
const TOKEN = process.env.REPLICATE_API_TOKEN;

describe.skipIf(!TOKEN)("Replicate vendor obligations", () => {
  it("generate-image returns the MIME its fact declares", async () => {
    const row = REPLICATE_DEFAULT_MODELS.find(
      (model) => model.kind === "image"
    );
    if (!row) {
      throw new Error("no Replicate image row");
    }
    const fact = operationsOf(row).find(
      (candidate) => candidate.operation === "generate-image"
    );
    const result = await replicateProvider({ config: { apiToken: TOKEN } })
      .imageModel?.(row.modelId)
      .doGenerate({
        aspectRatio: undefined,
        files: undefined,
        mask: undefined,
        n: 1,
        prompt: "a plain grey square",
        providerOptions: {},
        seed: undefined,
        size: undefined,
      });
    const first = result?.images[0];
    if (!(first instanceof Uint8Array)) {
      throw new Error("expected image bytes");
    }
    // PNG, JPEG, and WebP are distinguishable by their leading bytes, which is
    // the only MIME evidence the adapter passes through.
    const signature = Buffer.from(first.subarray(0, 12));
    const observed = signature
      .subarray(8, 12)
      .toString("ascii")
      .startsWith("WEBP")
      ? "image/webp"
      : signature[0] === 0x89
        ? "image/png"
        : "image/jpeg";
    expect(observed).toBe(fact?.outputs[0]);
  });
});
