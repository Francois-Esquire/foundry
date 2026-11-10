import { describe, expect, it } from "vitest";
import {
  estimateHeadline,
  familyEstimate,
} from "~/generate/family/family-cost";

describe("the estimate of a coordinated run", () => {
  it("counts one sheet call for each weight, not one for each glyph", () => {
    const estimate = familyEstimate({
      kind: "vector-model",
      model: "fal-ai/recraft/v4.1/text-to-vector",
      targets: 6,
      weights: 3,
    });
    expect(estimate.calls).toBe(3);
    expect(estimate.usd).toBe(0.24);
    expect(estimate.assumptions[0]).toBe(
      "Each call draws a sheet of up to 6 glyphs: 1 call for each of 3 faces is 3 calls."
    );
    expect(estimateHeadline(estimate)).toBe(
      "3 calls to the model, about $0.24."
    );
  });

  it("gives no dollar figure where the provider publishes no units for a call", () => {
    const estimate = familyEstimate({
      kind: "vector-model",
      model: "ideogram/vector/text-to-vector",
      targets: 6,
      weights: 3,
    });
    expect(estimate.calls).toBe(3);
    expect(estimate.usd).toBeUndefined();
    expect(estimateHeadline(estimate)).toBe(
      "3 calls to the model. No dollar figure can be given."
    );
    expect(estimate.assumptions.join(" ")).toContain(
      "does not publish how many units a call takes"
    );
  });

  it("gives no dollar figure for a model with no listed rate", () => {
    const estimate = familyEstimate({
      kind: "image-model",
      model: "a-model/nobody-listed",
      targets: 4,
      weights: 2,
    });
    expect(estimate.calls).toBe(2);
    expect(estimate.usd).toBeUndefined();
  });

  it("says the procedural strategy calls no model", () => {
    const estimate = familyEstimate({
      kind: "procedural",
      targets: 6,
      weights: 3,
    });
    expect(estimate).toMatchObject({ calls: 0, usd: 0 });
    expect(estimate.assumptions).toEqual([
      "The procedural strategy runs on this machine and calls no model, so it costs nothing.",
    ]);
  });

  it("asks for a single call for one glyph at one weight", () => {
    expect(
      familyEstimate({ kind: "vector-model", targets: 1, weights: 1 }).calls
    ).toBe(1);
    expect(
      estimateHeadline(
        familyEstimate({ kind: "vector-model", targets: 1, weights: 1 })
      )
    ).toBe("1 call to the model. No dollar figure can be given.");
  });
});
