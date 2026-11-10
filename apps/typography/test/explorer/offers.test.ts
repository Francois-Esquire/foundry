import { describe, expect, it } from "vitest";
import { extensionStanding } from "~/explorer/offers";
import type { Face } from "~/typeface/face";
import type { CharacterStatus } from "~/unicode/coverage";
import { describeFace } from "../helpers/fixtures";

const WEIGHT = {
  default: 400,
  max: 900,
  min: 100,
  name: "Weight",
  tag: "wght",
};
const PLANNED = [0x9_15, 0x9_24, 0x9_28];

const face = (overrides: Partial<Face> = {}): Face => ({
  description: describeFace(),
  id: "ab12:0",
  index: 0,
  sourceId: "ab12",
  ...overrides,
});

const all = (status: CharacterStatus) => () => status;

describe("whether Coverage offers a script extension for a face", () => {
  it("offers it to a static face that has none of the plan's characters", () => {
    expect(extensionStanding(face(), PLANNED, all("missing"))).toEqual({
      kind: "lacking",
    });
    expect(extensionStanding(face(), PLANNED, all("candidate"))).toEqual({
      kind: "lacking",
    });
  });

  it("says how many are in the face once the project has added them", () => {
    const classify = (codePoint: number): CharacterStatus =>
      codePoint === 0x9_15 ? "missing" : "added";
    expect(extensionStanding(face(), PLANNED, classify)).toEqual({
      held: 2,
      kind: "added",
    });
  });

  it("does not offer it when the source font has one of them, or the face is variable or pinned", () => {
    const notOffered = { kind: "not-offered" };
    const classify = (codePoint: number): CharacterStatus =>
      codePoint === 0x9_15 ? "source" : "missing";
    expect(extensionStanding(face(), PLANNED, classify)).toEqual(notOffered);
    const variable = face({ description: describeFace({ axes: [WEIGHT] }) });
    expect(extensionStanding(variable, PLANNED, all("missing"))).toEqual(
      notOffered
    );
    const pinned = face({
      description: describeFace({ axes: [WEIGHT] }),
      pinned: { location: { wght: 400 }, styleName: "Regular" },
    });
    expect(extensionStanding(pinned, PLANNED, all("missing"))).toEqual(
      notOffered
    );
  });
});
