import { describe, expect, it } from "vitest";
import { estimateCost } from "~/generation/family/cost";
import { LISTED_RATES, listedRateFor } from "~/generation/family/listed-rates";

const SENTENCE = /^[A-Z].*\.$/;
const SHOUTING_OR_DASHES = /[—!]/;

describe("estimating what a run costs", () => {
  const recraft = listedRateFor("fal-ai/recraft/v4.1/text-to-vector");
  const ideogram = listedRateFor("ideogram/vector/text-to-vector");
  const gptImage = listedRateFor("openai/gpt-image-2.6/flare/edit");

  it("multiplies targets by faces by the listed rate", () => {
    const estimate = estimateCost({
      faces: 3,
      kind: "vector-model",
      rate: recraft,
      targets: 6,
    });
    expect(estimate.calls).toBe(18);
    expect(estimate.usd).toBe(1.44);
    expect(estimate.assumptions).toEqual([
      "Each call draws one glyph: 6 glyphs for each of 3 faces is 18 calls.",
      "The listed rate for fal-ai/recraft/v4.1/text-to-vector is 0.08 dollars per image, read on 2026-11-10. The price may have changed since.",
      "Each call returns one image.",
      "No call is repeated. A sheet that fails or is asked for again costs the same again.",
      "This is an estimate from the listed rate. The provider's bill is the real figure.",
    ]);
  });

  it("counts one call per sheet when a call draws several glyphs", () => {
    const estimate = estimateCost({
      faces: 3,
      glyphsPerCall: 16,
      kind: "vector-model",
      rate: recraft,
      targets: 20,
    });
    expect(estimate.calls).toBe(6);
    expect(estimate.usd).toBe(0.48);
    expect(estimate.assumptions[0]).toBe(
      "Each call draws a sheet of up to 16 glyphs: 2 calls for each of 3 faces is 6 calls."
    );
  });

  it("gives no dollar figure when the provider does not say how many units a call takes", () => {
    for (const rate of [ideogram, gptImage]) {
      const estimate = estimateCost({
        faces: 3,
        glyphsPerCall: 6,
        kind: "image-model",
        rate,
        targets: 6,
      });
      expect(estimate.calls).toBe(3);
      expect(estimate.usd).toBeUndefined();
      expect(estimate.assumptions).toContain(
        "The provider does not publish how many units a call takes, so no dollar figure can be given. Run one call and read the charge on the provider's dashboard."
      );
    }
  });

  it("prices units when the caller knows how many a call takes", () => {
    const estimate = estimateCost({
      faces: 3,
      glyphsPerCall: 6,
      kind: "vector-model",
      rate: ideogram && { ...ideogram, unitsPerCall: 4 },
      targets: 6,
    });
    expect(estimate.usd).toBe(0.12);
    expect(estimate.assumptions).toContain("Each call takes 4 units.");
  });

  it("gives calls and no figure for a model without a listed rate", () => {
    const estimate = estimateCost({
      faces: 2,
      kind: "image-model",
      rate: listedRateFor("someone/else"),
      targets: 5,
    });
    expect(estimate).toEqual({
      assumptions: [
        "Each call draws one glyph: 5 glyphs for each of 2 faces is 10 calls.",
        "No call is repeated. A sheet that fails or is asked for again costs the same again.",
        "No listed rate is known for this model, so no dollar figure can be given.",
      ],
      calls: 10,
    });
  });

  it("says that strategies without a model cost nothing", () => {
    expect(
      estimateCost({ faces: 3, kind: "procedural", rate: recraft, targets: 6 })
    ).toEqual({
      assumptions: [
        "The procedural strategy runs on this machine and calls no model, so it costs nothing.",
      ],
      calls: 0,
      usd: 0,
    });
    const replay = estimateCost({ faces: 3, kind: "recorded-run", targets: 6 });
    expect(replay.usd).toBe(0);
    expect(replay.assumptions[0]).toContain("calls no model");
  });

  it("estimates nothing for nothing", () => {
    const estimate = estimateCost({
      faces: 0,
      kind: "vector-model",
      rate: recraft,
      targets: 6,
    });
    expect(estimate.calls).toBe(0);
    expect(estimate.usd).toBe(0);
  });

  it("writes every assumption as a plain sentence", () => {
    const questions = LISTED_RATES.flatMap((rate) => [
      estimateCost({ faces: 3, kind: "vector-model", rate, targets: 6 }),
      estimateCost({
        faces: 1,
        glyphsPerCall: 6,
        kind: "image-model",
        rate,
        targets: 1,
      }),
    ]);
    for (const assumption of questions.flatMap((item) => item.assumptions)) {
      expect(assumption).toMatch(SENTENCE);
      expect(assumption).not.toMatch(SHOUTING_OR_DASHES);
    }
  });

  it("dates every listed rate", () => {
    expect(LISTED_RATES.map((rate) => rate.listedOn)).toEqual([
      "2026-11-10",
      "2026-11-10",
      "2026-11-10",
    ]);
  });
});
