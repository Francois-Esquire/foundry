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

function keyed(apiKey = "fal_key") {
  const manager = new ModelManager();
  manager.register(falProvider({ config: { apiKey } }));
  return manager;
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

describe("select over the shipped FAL catalog", () => {
  it.each(REQUEST_SELECTIONS)(
    "admits %s in request mode on %s",
    (operation, modelId, mime) => {
      const selection = keyed().select(operation, { provider: "fal" });
      expect(selection.model.id).toBe(modelId);
      expect(selection.fact.operation).toBe(operation);
      expect(selection.fact.mode).toBe("request");
      expect(selection.fact.outputs[0]).toBe(mime);
    }
  );

  it("admits H3 Max Director as continuous without a feed", () => {
    const selection = keyed().select("generate-video", {
      mode: "live",
      model: LIVE_ROWS.h3,
      provider: "fal",
    });
    expect(selection.fact.delivery).toBe("continuous");
    expect(selection.fact.inputs).toEqual(["direction"]);
    expect(selection.fact.required).toEqual(["direction"]);
    expect(selection.fact.outputs).toEqual(["video/webm"]);
  });

  it("admits Lucy 2.5 as continuous with a required feed", () => {
    const selection = keyed().select("generate-video", {
      mode: "live",
      model: LIVE_ROWS.lucy,
      provider: "fal",
    });
    expect(selection.fact.delivery).toBe("continuous");
    expect(selection.fact.inputs).toContain("feed");
    expect(selection.fact.required).toContain("feed");
    expect(selection.fact.outputs).toEqual(["video/webm"]);
  });

  it.each([LIVE_ROWS.klein, LIVE_ROWS.lcm])(
    "admits %s as result-per-input",
    (model) => {
      const selection = keyed().select("generate-image", {
        mode: "live",
        model,
        provider: "fal",
      });
      expect(selection.fact.delivery).toBe("result-per-input");
      expect(selection.fact.inputs).toContain("frame");
    }
  );

  it("refuses segment-video in live mode", () => {
    expect(() =>
      keyed().select("segment-video", { mode: "live", provider: "fal" })
    ).toThrow(/segment-video/);
  });

  it("refuses every Operation when the key is absent", () => {
    const manager = new ModelManager();
    manager.register(falProvider());
    expect(() => manager.select("segment-image", { provider: "fal" })).toThrow(
      /No credentialed provider/
    );
  });

  it("offers segment-image with Availability and absent price", () => {
    const offers = keyed().offers("segment-image");
    expect(offers).toHaveLength(1);
    const [offer] = offers;
    expect(offer?.provider).toBe("fal");
    expect(offer?.available).toBe(true);
    expect(offer?.model.id).toBe("fal-ai/sam-3/image");
    expect(offer?.model.price).toBeUndefined();
    expect(offer?.fact.outputs[0]).toBe("application/json");
  });
});
