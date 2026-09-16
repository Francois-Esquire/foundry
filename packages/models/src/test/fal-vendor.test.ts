/**
 * Caller-owned instrument. Nothing here runs without a key, and nothing here
 * is a gate: each test names the specification.md "Evidence limits" row it
 * would close, and its absence of a run is the deferral, not a pass.
 *
 *   FAL_KEY=… bun run --cwd=packages/models test -- fal-vendor
 *
 * Two tests need media the repository does not carry. Supply them and they run;
 * omit them and they skip:
 *
 *   FAL_KEY=… FAL_VENDOR_VIDEO=/abs/path/clip.mp4 \
 *     bun run --cwd=packages/models test -- fal-vendor
 *
 * The four live rows (Klein, LCM, Lucy 2.5, H3 Max Director) are not exercised
 * here: opening their transports is Step 05's, and their vendor obligations are
 * carried with it. Token minting, which those rows depend on, is proved here.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { FAL_DEFAULT_MODELS } from "../fal/catalog";
import { falProvider } from "../fal/provider";
import { operationsOf } from "../provider";
import type { CapabilityFact, OperationName } from "../types";

// eslint-disable-next-line turbo/no-undeclared-env-vars
const FAL_KEY = process.env.FAL_KEY;
// eslint-disable-next-line turbo/no-undeclared-env-vars
const VIDEO_PATH = process.env.FAL_VENDOR_VIDEO;

/** A 1x1 PNG, inlined so the instrument depends on no file outside the repo. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function provider() {
  return falProvider({ config: { apiKey: FAL_KEY ?? "" } });
}

function factOf(modelId: string, operation: OperationName): CapabilityFact {
  const row = FAL_DEFAULT_MODELS.find((model) => model.id === modelId);
  if (!row) {
    throw new Error(`no catalog row for ${modelId}`);
  }
  const fact = operationsOf(row).find(
    (candidate) =>
      candidate.operation === operation && candidate.mode === "request"
  );
  if (!fact) {
    throw new Error(`no ${operation} fact on ${modelId}`);
  }
  return fact;
}

describe.skipIf(!FAL_KEY)("FAL vendor obligations", () => {
  it("Evidence limits: SAM 3 image honours its required inputs and returns PNG masks", async () => {
    const output = await provider()
      .mediaModel?.("fal-ai/sam-3/image")
      .run({
        image: { bytes: new Uint8Array(ONE_PIXEL_PNG), mime: "image/png" },
        operation: "segment-image",
        prompt: { kind: "text", text: "object" },
      });
    if (output?.operation !== "segment-image") {
      throw new Error("expected a segment-image output");
    }
    expect(output.masks.length).toBeGreaterThan(0);
    expect(output.masks[0]?.image.mime).toBe("image/png");
  });

  it("Evidence limits: FAL music is reachable by subscribe and returns audio", async () => {
    const fact = factOf("fal-ai/elevenlabs/music", "generate-music");
    const output = await provider()
      .mediaModel?.("fal-ai/elevenlabs/music")
      .run({ direction: "a short warm pad", operation: "generate-music" });
    if (output?.operation !== "generate-music") {
      throw new Error("expected a generate-music output");
    }
    expect(output.audio.mime).toBe(fact.outputs[0]);
    expect(output.audio.bytes.byteLength).toBeGreaterThan(0);
  });

  it("Evidence limits: FAL sound effects are reachable by subscribe and return audio", async () => {
    const fact = factOf(
      "fal-ai/elevenlabs/sound-effects/v2",
      "generate-sound-effect"
    );
    const output = await provider()
      .mediaModel?.("fal-ai/elevenlabs/sound-effects/v2")
      .run({
        direction: "a single door slam",
        durationSeconds: 2,
        operation: "generate-sound-effect",
      });
    if (output?.operation !== "generate-sound-effect") {
      throw new Error("expected a generate-sound-effect output");
    }
    expect(output.audio.mime).toBe(fact.outputs[0]);
  });

  it("Evidence limits: a Provider-minted token comes back scoped and key-free", async () => {
    const access = await provider().grant?.(
      "fal-ai/flux-2/klein/realtime",
      "generate-image"
    );
    if (access?.kind !== "token") {
      throw new Error(`expected a token grant, got ${String(access?.kind)}`);
    }
    expect(access.token.length).toBeGreaterThan(0);
    expect(access.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(access).includes(FAL_KEY ?? "")).toBe(false);
  });

  it("Evidence limits: generate-image returns the MIME its fact declares", async () => {
    const fact = factOf("fal-ai/flux/dev", "generate-image");
    const result = await provider().imageModel?.("fal-ai/flux/dev").doGenerate({
      aspectRatio: undefined,
      files: undefined,
      mask: undefined,
      n: 1,
      prompt: "a plain grey square",
      providerOptions: {},
      seed: undefined,
      size: undefined,
    });
    const images = (
      result?.providerMetadata?.fal as
        | { images?: { contentType?: string }[] }
        | undefined
    )?.images;
    expect(images?.[0]?.contentType).toBe(fact.outputs[0]);
  });

  describe.skipIf(!VIDEO_PATH)("with a caller-supplied video", () => {
    it("Evidence limits: transcribe accepts source video", async () => {
      const bytes = await readFile(VIDEO_PATH ?? "");
      const result = await provider()
        .transcriptionModel?.("wizper")
        .doGenerate({
          audio: new Uint8Array(bytes),
          mediaType: "video/mp4",
          providerOptions: {},
        });
      expect(result?.text.length).toBeGreaterThan(0);
    });

    it("Evidence limits: SAM 3.1 video returns per-frame tracks, or only a preview", async () => {
      const bytes = await readFile(VIDEO_PATH ?? "");
      const output = await provider()
        .mediaModel?.("fal-ai/sam-3-1/video")
        .run({
          operation: "segment-video",
          prompt: { kind: "text", text: "person" },
          video: { bytes: new Uint8Array(bytes), mime: "video/mp4" },
        });
      if (output?.operation !== "segment-video") {
        throw new Error("expected a segment-video output");
      }
      // The pinned endpoint contract declares only a segmented video, so an
      // empty track list here confirms the gap rather than failing the run.
      expect(output.preview?.bytes.byteLength).toBeGreaterThan(0);
    });
  });
});
