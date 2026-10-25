import { describe, expect, it } from "vitest";
import {
  channels,
  grounds,
  packagePigments,
} from "../../src/web/ladder/ink-ladder";
import { islandPigment } from "../../src/web/layout/island-pigment";

const hexColour = /^#[0-9a-f]{6}$/;

describe("island pigment", () => {
  it("washes one of the ladder's pigments with the paper, as the coast sheet was painted", () => {
    const territory = { id: "@foundry/spyglass" };
    const pigment = islandPigment(territory);
    expect(pigment).toMatch(hexColour);
    expect(islandPigment(territory)).toBe(pigment);
    const paper = channels(grounds.land);
    const washes = packagePigments.map((hex) =>
      channels(hex)
        .map((base, i) => Math.round(base + ((paper[i] ?? 0) - base) * 0.48))
        .join(",")
    );
    expect(washes).toContain(channels(pigment).join(","));
  });
  it("gives different islands different washes", () => {
    const washes = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
        islandPigment({ id })
      )
    );
    expect(washes.size).toBeGreaterThan(1);
  });
});
