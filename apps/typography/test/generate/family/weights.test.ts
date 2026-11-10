import { describe, expect, it } from "vitest";
import {
  canCoordinate,
  distinctWeights,
  namedWeights,
  otherAxesOf,
  startingWeights,
  weightAxisOf,
  weightName,
  weightToAdd,
} from "~/generate/family/weights";
import type { Face, FaceDescription } from "~/typeface/face";
import { describeFace } from "../../helpers/fixtures";

const WEIGHT = {
  default: 400,
  max: 900,
  min: 100,
  name: "Weight",
  tag: "wght",
};
const WIDTH = { default: 100, max: 100, min: 62.5, name: "Width", tag: "wdth" };

const faceOf = (
  description: Partial<FaceDescription>,
  pinned?: Face["pinned"]
): Face => ({
  description: describeFace(description),
  id: "face",
  index: 0,
  pinned,
  sourceId: "source",
});

const variable = faceOf({
  axes: [WEIGHT, WIDTH],
  instances: [
    { location: { wdth: 100, wght: 700 }, name: "Bold" },
    { location: { wght: 300 }, name: "Light" },
    { location: { wdth: 75, wght: 300 }, name: "Condensed Light" },
  ],
});

describe("the weights of a coordinated run", () => {
  it("finds a weight axis only on a variable face that has one", () => {
    expect(weightAxisOf(variable)).toEqual(WEIGHT);
    expect(canCoordinate(variable)).toBe(true);
    expect(canCoordinate(faceOf({}))).toBe(false);
    expect(canCoordinate(faceOf({ axes: [WIDTH] }))).toBe(false);
    // A pinned instance is static, whatever its source's axes are.
    expect(
      canCoordinate(
        faceOf(
          { axes: [WEIGHT] },
          { location: { wght: 300 }, styleName: "Light" }
        )
      )
    ).toBe(false);
  });

  it("names the axes a run leaves at their defaults", () => {
    expect(otherAxesOf(variable)).toEqual([WIDTH]);
    expect(otherAxesOf(faceOf({ axes: [WEIGHT] }))).toEqual([]);
  });

  it("starts from the axis minimum, default and maximum, without repeats", () => {
    expect(startingWeights(WEIGHT)).toEqual([100, 400, 900]);
    expect(startingWeights({ ...WEIGHT, default: 400, min: 400 })).toEqual([
      400, 900,
    ]);
  });

  it("offers the named instances that move the weight axis alone, lightest first", () => {
    expect(namedWeights(variable)).toEqual([
      { name: "Light", weight: 300 },
      { name: "Bold", weight: 700 },
    ]);
    expect(namedWeights(faceOf({}))).toEqual([]);
  });

  it("calls a weight by its named instance, or by its value on the axis", () => {
    expect(weightName(variable, 700)).toBe("Bold");
    expect(weightName(variable, 350)).toBe("wght350");
  });

  it("keeps weights inside the axis, once each, lightest first", () => {
    expect(distinctWeights(WEIGHT, [900, 5000, 400, 1, 400])).toEqual([
      100, 400, 900,
    ]);
    expect(distinctWeights(WEIGHT, [])).toEqual([]);
  });

  it("starts a new weight in the middle of the widest gap", () => {
    expect(weightToAdd(WEIGHT, [100, 400, 900])).toBe(650);
    expect(weightToAdd(WEIGHT, [100, 650, 900])).toBe(375);
    expect(weightToAdd(WEIGHT, [400, 500])).toBe(700);
  });
});
