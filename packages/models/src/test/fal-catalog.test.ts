import { describe, expect, it } from "vitest";
import { FAL_DEFAULT_MODELS } from "../fal/catalog";
import { falProvider } from "../fal/provider";
import { ModelManager } from "../manager";
import { operationsOf } from "../provider";
import type { CapabilityFact, OperationName } from "../types";

const LIVE_ROWS = {
  h3: "minimax/h3-max/director",
  klein: "fal-ai/flux-2/klein/realtime",
  lcm: "fal-ai/fast-lcm-diffusion/image-to-image",
  lucy: "decart/lucy-2-5/realtime",
} as const;

/** Every Operation the architecture's coverage table routes to FAL. */
const FAL_SERVED: readonly OperationName[] = [
  "generate-image",
  "generate-video",
  "generate-speech",
  "generate-music",
  "generate-sound-effect",
  "transcribe",
  "segment-image",
  "segment-video",
];

function factsWith(
  predicate: (fact: CapabilityFact) => boolean
): { id: string; fact: CapabilityFact }[] {
  return FAL_DEFAULT_MODELS.flatMap((row) =>
    operationsOf(row)
      .filter(predicate)
      .map((fact) => ({ fact, id: row.id }))
  );
}

/** The fact a shipped row declares for one Operation in one mode, if any. */
function factOf(
  model: string,
  operation: OperationName,
  mode: CapabilityFact["mode"]
): CapabilityFact | undefined {
  const row = FAL_DEFAULT_MODELS.find((entry) => entry.id === model);
  return row
    ? operationsOf(row).find(
        (fact) => fact.operation === operation && fact.mode === mode
      )
    : undefined;
}

describe("FAL catalog facts", () => {
  it("declares every fact explicitly, with required inside inputs and a MIME", () => {
    for (const row of FAL_DEFAULT_MODELS) {
      expect(row.operations, `${row.id} declares no facts`).toBeDefined();
      for (const fact of operationsOf(row)) {
        for (const form of fact.required) {
          expect(fact.inputs, `${row.id} ${fact.operation}`).toContain(form);
        }
        expect(
          fact.outputs.length,
          `${row.id} ${fact.operation}`
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("covers every Operation the architecture routes to FAL", () => {
    for (const operation of FAL_SERVED) {
      expect(
        factsWith((fact) => fact.operation === operation).length,
        operation
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("carries continuous delivery on exactly the Lucy and H3 rows", () => {
    expect(
      factsWith((fact) => fact.delivery === "continuous").map(
        (entry) => entry.id
      )
    ).toEqual([LIVE_ROWS.lucy, LIVE_ROWS.h3]);
  });

  it("carries result-per-input delivery on exactly the Klein and LCM rows", () => {
    expect(
      factsWith((fact) => fact.delivery === "result-per-input").map(
        (entry) => entry.id
      )
    ).toEqual([LIVE_ROWS.klein, LIVE_ROWS.lcm]);
  });

  it("lists feed on the Lucy fact and on no other fact", () => {
    expect(
      factsWith((fact) => fact.inputs.includes("feed")).map((entry) => entry.id)
    ).toEqual([LIVE_ROWS.lucy]);
    expect(
      factsWith((fact) => fact.required.includes("feed")).map(
        (entry) => entry.id
      )
    ).toEqual([LIVE_ROWS.lucy]);
  });

  it("ships no live fact on any SAM row", () => {
    const sam = FAL_DEFAULT_MODELS.filter((row) => row.id.includes("sam-3"));
    expect(sam.length).toBeGreaterThanOrEqual(2);
    for (const row of sam) {
      expect(
        operationsOf(row).map((fact) => fact.mode),
        row.id
      ).toEqual(["request"]);
    }
  });
});

/** The row and MIME a defaulted request-mode `select` must land on, per Operation. */
const REQUEST_SELECTIONS: readonly [OperationName, string, string][] = [
  ["generate-image", "fal-ai/flux/dev", "image/jpeg"],
  ["generate-video", "fal-ai/minimax/video-01", "video/mp4"],
  ["generate-speech", "fal-ai/minimax/speech-02-hd", "audio/mpeg"],
  ["generate-music", "fal-ai/elevenlabs/music", "audio/mpeg"],
  ["generate-sound-effect", "fal-ai/elevenlabs/sound-effects/v2", "audio/mpeg"],
  ["transcribe", "fal-ai/wizper", "text/plain"],
  ["segment-image", "fal-ai/sam-3/image", "application/json"],
  ["segment-video", "fal-ai/sam-3-1/video", "application/json"],
];

describe("facts on the shipped FAL catalog", () => {
  it.each(REQUEST_SELECTIONS)(
    "declares %s in request mode on %s",
    (operation, modelId, mime) => {
      const fact = factOf(modelId, operation, "request");
      expect(fact?.outputs[0]).toBe(mime);
    }
  );

  it("declares H3 Max Director as continuous without a feed", () => {
    const fact = factOf(LIVE_ROWS.h3, "generate-video", "live");
    expect(fact?.delivery).toBe("continuous");
    expect(fact?.inputs).toEqual(["direction"]);
    expect(fact?.required).toEqual(["direction"]);
    expect(fact?.outputs).toEqual(["video/webm"]);
  });

  it("declares Lucy 2.5 as continuous with a required feed", () => {
    const fact = factOf(LIVE_ROWS.lucy, "generate-video", "live");
    expect(fact?.delivery).toBe("continuous");
    expect(fact?.inputs).toContain("feed");
    expect(fact?.required).toContain("feed");
    expect(fact?.outputs).toEqual(["video/webm"]);
  });

  it.each([LIVE_ROWS.klein, LIVE_ROWS.lcm])(
    "declares %s as result-per-input",
    (model) => {
      const fact = factOf(model, "generate-image", "live");
      expect(fact?.delivery).toBe("result-per-input");
      expect(fact?.inputs).toContain("frame");
    }
  );

  it("declares no live segment-video", () => {
    expect(
      FAL_DEFAULT_MODELS.some((row) =>
        operationsOf(row).some(
          (fact) => fact.operation === "segment-video" && fact.mode === "live"
        )
      )
    ).toBe(false);
  });

  it("resolves segmentation only with a key", () => {
    const keyed = new ModelManager({
      providers: [falProvider({ config: { apiKey: "fal_key" } })],
    });
    expect(keyed.resolve("segmentation", "fal-ai/sam-3/image").provider).toBe(
      "fal"
    );
    const bare = new ModelManager({ providers: [falProvider()] });
    expect(() =>
      bare.resolve("segmentation", "fal/fal-ai/sam-3/image")
    ).toThrow('Provider "fal" is unavailable');
  });
});
