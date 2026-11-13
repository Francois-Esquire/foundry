import { expect, it } from "vitest";
import { readinessOf } from "~/generate/family/readiness";
import type { Draft } from "~/generate/session";

const draft: Draft = {
  language: "",
  recordedId: "",
  scope: "script:Latn",
  source: "typed",
  strategy: "vector-model",
  typed: "",
};

it("uses the unavailable strategy's reason before other checks", () => {
  const option = {
    availability: { available: false as const, reason: "No key." },
    kind: "vector-model" as const,
    name: "Vector",
    summary: "Draws glyphs.",
  };
  expect(readinessOf(option, 1, 0, 0, draft)).toEqual({
    ready: false,
    reason: "No key.",
  });
});

it("requires two different weights", () => {
  expect(readinessOf(undefined, 1, 1, 0, draft)).toEqual({
    ready: false,
    reason: "Choose at least two different weights.",
  });
});

it("explains when every character is already in the face", () => {
  expect(readinessOf(undefined, 2, 0, 1, draft)).toEqual({
    ready: false,
    reason:
      "Every character asked for is already in the face, so there is nothing to generate.",
  });
});

it("uses the draft's empty reason when no characters were left out", () => {
  expect(readinessOf(undefined, 2, 0, 0, draft)).toEqual({
    ready: false,
    reason: "Type the characters to generate.",
  });
});

it("allows targets at two weights", () => {
  expect(readinessOf(undefined, 2, 1, 0, draft)).toEqual({ ready: true });
});
