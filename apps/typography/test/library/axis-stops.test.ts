import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { axisStep, axisStops, moveAxis } from "~/library/axis-stops";
import { fontBytes } from "../helpers/fixtures";

const WEIGHT = {
  default: 400,
  max: 900,
  min: 100,
  name: "Weight",
  tag: "wght",
};
const WIDTH = { default: 100, max: 100, min: 62.5, name: "Width", tag: "wdth" };
const SLANT = { default: 0, max: 0, min: -2, name: "Slant", tag: "slnt" };

describe("axis controls", () => {
  it("steps by one unit on a wide axis and finer on a narrow one", () => {
    expect(axisStep(WEIGHT)).toBe(1);
    expect(axisStep(WIDTH)).toBe(0.5);
    expect(axisStep(SLANT)).toBe(0.01);
  });

  it("puts a named instance on an axis only when the other axes rest", () => {
    const instances = [
      { location: { wdth: 100, wght: 400 }, name: "Regular" },
      { location: { wdth: 100, wght: 700 }, name: "Bold" },
      { location: { wdth: 75, wght: 400 }, name: "Condensed" },
      { location: { wdth: 75, wght: 700 }, name: "Condensed Bold" },
    ];
    expect(axisStops(WEIGHT, [WEIGHT, WIDTH], instances)).toEqual([
      { name: "Regular", value: 400 },
      { name: "Bold", value: 700 },
    ]);
    expect(axisStops(WIDTH, [WEIGHT, WIDTH], instances)).toEqual([
      { name: "Condensed", value: 75 },
      { name: "Regular", value: 100 },
    ]);
  });

  it("gives a real two-axis face one stop per value on each axis", () => {
    const { axes, instances } = harfBuzzReader.open(
      fontBytes("devanagari")
    ).description;
    const [weight, width] = axes;
    if (!(weight && width)) {
      throw new Error("The fixture should have two axes.");
    }
    const weights = axisStops(weight, axes, instances);
    expect(weights.map((stop) => stop.value)).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800, 900,
    ]);
    expect(weights.at(-1)?.name).toBe("Black");
    expect(axisStops(width, axes, instances)).toEqual([
      { name: "Regular", value: 100 },
    ]);
  });

  it("moves one axis and leaves the others", () => {
    expect(moveAxis({ wdth: 100, wght: 400 }, "wght", 650)).toEqual({
      wdth: 100,
      wght: 650,
    });
  });
});
