import { describe, expect, it } from "vitest";
import {
  faceLabel,
  locationLabel,
  variationLabel,
  weightLabel,
  widthLabel,
} from "~/library/face-names";
import type { Face } from "~/typeface/face";
import { describeFace } from "../helpers/fixtures";

const face = (overrides: Partial<Face> = {}): Face => ({
  description: describeFace(),
  id: "face",
  index: 0,
  sourceId: "source",
  ...overrides,
});

const WEIGHT = {
  default: 400,
  max: 900,
  min: 100,
  name: "Weight",
  tag: "wght",
};
const WIDTH = { default: 100, max: 100, min: 62.5, name: "Width", tag: "wdth" };

describe("face names", () => {
  it("labels a face by family and style", () => {
    expect(faceLabel(face())).toBe("Specimen Regular");
  });

  it("names a pinned instance by its own style, not its source's", () => {
    const pinned = face({
      description: describeFace({ axes: [WEIGHT] }),
      pinned: { location: { wght: 700 }, styleName: "Bold" },
    });
    expect(faceLabel(pinned)).toBe("Specimen Bold");
    expect(variationLabel(pinned)).toBe("Pinned at wght 700");
  });

  it("says whether a face is static or variable, with each axis and its range", () => {
    expect(variationLabel(face())).toBe("Static");
    expect(
      variationLabel(
        face({ description: describeFace({ axes: [WEIGHT, WIDTH] }) })
      )
    ).toBe("Variable: Weight 100 to 900, Width 62.5 to 100");
  });

  it("names the usual weight and width classes and leaves the others as numbers", () => {
    expect(weightLabel(400)).toBe("400 Regular");
    expect(weightLabel(450)).toBe("450");
    expect(widthLabel(5)).toBe("5 Normal");
    expect(widthLabel(12)).toBe("12");
  });

  it("writes a location in tag order", () => {
    expect(locationLabel({ wdth: 80, wght: 700 })).toBe("wdth 80, wght 700");
  });
});
