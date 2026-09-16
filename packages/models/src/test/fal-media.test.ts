import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FalEndpointClient, FalFetch } from "../fal/client";
import { getFalRuntime, setFalRuntime } from "../fal/client";
import { falMediaModel } from "../fal/media";
import { falProvider } from "../fal/provider";
import type { MediaInput, SegmentationPrompt } from "../types";
import MUSIC from "./fixtures/fal/music.json";
import SEGMENT_IMAGE from "./fixtures/fal/segment-image.json";
import SEGMENT_IMAGE_NO_METADATA from "./fixtures/fal/segment-image-no-metadata.json";
import SEGMENT_VIDEO from "./fixtures/fal/segment-video.json";
import SOUND_EFFECT from "./fixtures/fal/sound-effect.json";

const TEXT_PROMPT: SegmentationPrompt = { kind: "text", text: "wheel" };

interface Harness {
  calls: { endpointId: string; input: Record<string, unknown> }[];
  client: FalEndpointClient;
  fetched: string[];
  uploads: Blob[];
}

/** A stubbed client and fetch in the module-level holder the Provider sets. */
function install(
  data: unknown,
  options: { subscribe?: FalEndpointClient["subscribe"] } = {}
): Harness {
  const uploads: Blob[] = [];
  const calls: { endpointId: string; input: Record<string, unknown> }[] = [];
  const fetched: string[] = [];
  const client: FalEndpointClient = {
    realtime: {
      connect: () => {
        throw new Error("not used by media");
      },
      open: () => {
        throw new Error("not used by media");
      },
    },
    storage: {
      upload: (file) => {
        uploads.push(file);
        return Promise.resolve(
          `https://v3.fal.media/files/upload-${uploads.length}`
        );
      },
    },
    subscribe:
      options.subscribe ??
      ((endpointId, request) => {
        calls.push({ endpointId, input: request.input });
        return Promise.resolve({ data, requestId: "req-1" });
      }),
  };
  const stubFetch: FalFetch = (input) => {
    fetched.push(input);
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
  };
  setFalRuntime({ client, credentials: "fal_key", fetch: stubFetch });
  return { calls, client, fetched, uploads };
}

function media(endpointId: string) {
  return falMediaModel(endpointId, () => true);
}

const IMAGE_INPUT: MediaInput = {
  image: { bytes: new Uint8Array([9, 9]), mime: "image/png" },
  operation: "segment-image",
  prompt: TEXT_PROMPT,
};

afterEach(() => {
  setFalRuntime(null);
});

describe("falMediaModel — segment-image", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = install(SEGMENT_IMAGE);
  });

  it("uploads the bytes once and calls the endpoint with the uploaded url", async () => {
    await media("fal-ai/sam-3/image").run(IMAGE_INPUT);
    expect(harness.uploads).toHaveLength(1);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.endpointId).toBe("fal-ai/sam-3/image");
    expect(harness.calls[0]?.input.image_url).toBe(
      "https://v3.fal.media/files/upload-1"
    );
    expect(harness.calls[0]?.input.prompt).toBe("wheel");
  });

  it("translates the vendor masks into Masks and leaks no vendor JSON", async () => {
    const output = await media("fal-ai/sam-3/image").run(IMAGE_INPUT);
    expect(output.operation).toBe("segment-image");
    if (output.operation !== "segment-image") {
      throw new Error("unreachable");
    }
    expect(Object.keys(output).sort()).toEqual(["masks", "operation"]);
    expect(output.masks.map((mask) => mask.id)).toEqual(["mask-0", "mask-1"]);
    expect(output.masks.map((mask) => mask.label)).toEqual(["wheel", "wheel"]);
    expect(output.masks.map((mask) => mask.score)).toEqual([0.94, 0.71]);
    expect(output.masks[0]?.box).toEqual({
      height: 0.5,
      width: 0.25,
      x: 0.375,
      y: 0.25,
    });
    for (const mask of output.masks) {
      expect(mask.image.mime).toBe("image/png");
      expect(mask.image.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(Object.keys(mask.image).sort()).toEqual(["bytes", "mime"]);
    }
    expect(harness.fetched).toEqual([
      "https://v3.fal.media/files/mask-0.png",
      "https://v3.fal.media/files/mask-1.png",
    ]);
  });

  it("omits the label when the prompt carries no concept text", async () => {
    const output = await media("fal-ai/sam-3/image").run({
      ...IMAGE_INPUT,
      prompt: { kind: "points", points: [{ label: 1, x: 1, y: 2 }] },
    });
    if (output.operation !== "segment-image") {
      throw new Error("unreachable");
    }
    expect(output.masks[0]?.label).toBeUndefined();
    expect(harness.calls[0]?.input.point_prompts).toEqual([
      { label: 1, x: 1, y: 2 },
    ]);
  });

  it("falls back to the top-level scores and boxes when metadata is absent", async () => {
    install(SEGMENT_IMAGE_NO_METADATA);
    const output = await media("fal-ai/sam-3/image").run(IMAGE_INPUT);
    if (output.operation !== "segment-image") {
      throw new Error("unreachable");
    }
    expect(output.masks).toHaveLength(1);
    expect(output.masks[0]?.id).toBe("mask-0");
    expect(output.masks[0]?.score).toBe(0.62);
    expect(output.masks[0]?.box).toEqual({
      height: 0.2,
      width: 0.4,
      x: 0.3,
      y: 0.4,
    });
  });
});

describe("falMediaModel — segment-video", () => {
  it("returns the segmented video as the preview and declares no tracks", async () => {
    const harness = install(SEGMENT_VIDEO);
    const output = await media("fal-ai/sam-3-1/video").run({
      operation: "segment-video",
      prompt: TEXT_PROMPT,
      video: { bytes: new Uint8Array([7]), mime: "video/mp4" },
    });
    if (output.operation !== "segment-video") {
      throw new Error("unreachable");
    }
    expect(harness.uploads).toHaveLength(1);
    expect(harness.calls[0]?.input.video_url).toBe(
      "https://v3.fal.media/files/upload-1"
    );
    expect(Object.keys(output).sort()).toEqual([
      "operation",
      "preview",
      "tracks",
    ]);
    expect(output.preview?.mime).toBe("video/mp4");
    // The pinned endpoint contract declares one segmented video and no
    // per-frame masks, so a Track cannot be built from it.
    expect(output.tracks).toEqual([]);
  });
});

describe("falMediaModel — audio", () => {
  it.each([
    ["generate-music" as const, MUSIC, "fal-ai/elevenlabs/music"],
    [
      "generate-sound-effect" as const,
      SOUND_EFFECT,
      "fal-ai/elevenlabs/sound-effects/v2",
    ],
  ])(
    "returns %s audio at the row's declared MIME",
    async (operation, fixture, endpointId) => {
      const harness = install(fixture);
      const output = await media(endpointId).run({
        direction: "a slow marimba loop",
        durationSeconds: 12,
        operation,
      });
      if (
        output.operation === "segment-image" ||
        output.operation === "segment-video"
      ) {
        throw new Error("unreachable");
      }
      expect(output.audio.mime).toBe("audio/mpeg");
      expect(harness.uploads).toHaveLength(0);
      expect(Object.keys(output).sort()).toEqual(["audio", "operation"]);
    }
  );

  it("sends the direction and duration in the endpoint's own fields", async () => {
    const music = install(MUSIC);
    await media("fal-ai/elevenlabs/music").run({
      direction: "warm ambient pads",
      durationSeconds: 30,
      operation: "generate-music",
    });
    expect(music.calls[0]?.input).toEqual({
      music_length_ms: 30_000,
      prompt: "warm ambient pads",
    });
    const sound = install(SOUND_EFFECT);
    await media("fal-ai/elevenlabs/sound-effects/v2").run({
      direction: "a door slam",
      durationSeconds: 2,
      operation: "generate-sound-effect",
    });
    expect(sound.calls[0]?.input).toEqual({
      duration_seconds: 2,
      text: "a door slam",
    });
  });
});

describe("falMediaModel — refusal and abort", () => {
  it("rejects when the run is aborted", async () => {
    const controller = new AbortController();
    install(SEGMENT_IMAGE, {
      // Never settles without a signal, so dropping the forwarding shows up as
      // a failure rather than a pass.
      subscribe: (_endpointId, request) =>
        new Promise((_resolve, reject) => {
          const signal = request.abortSignal;
          if (!signal) {
            return;
          }
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });
    const pending = media("fal-ai/sam-3/image").run(IMAGE_INPUT, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("refuses before any client call when the Provider has no key", async () => {
    const harness = install(SEGMENT_IMAGE);
    const model = falProvider().mediaModel?.("fal-ai/sam-3/image");
    await expect(model?.run(IMAGE_INPUT)).rejects.toThrow(
      /No credentialed provider/
    );
    expect(harness.uploads).toHaveLength(0);
    expect(harness.calls).toHaveLength(0);
  });

  it("leaves a configured client in place when an unkeyed Provider is built", () => {
    const harness = install(SEGMENT_IMAGE);
    falProvider();
    expect(getFalRuntime()?.client).toBe(harness.client);
  });
});
