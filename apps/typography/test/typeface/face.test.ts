import { describe, expect, it } from "vitest";
import { instanceAt } from "~/typeface/face";
import { describeFace } from "../helpers/fixtures";

const VARIABLE = describeFace({
  axes: [
    { default: 400, max: 900, min: 100, name: "Weight", tag: "wght" },
    { default: 100, max: 125, min: 75, name: "Width", tag: "wdth" },
  ],
  instances: [
    { location: { wght: 700 }, name: "Bold" },
    { location: { wdth: 75, wght: 700 }, name: "Condensed Bold" },
  ],
});

describe("the named instance at a location", () => {
  it("treats an axis left out as sitting at its default", () => {
    expect(instanceAt(VARIABLE, { wdth: 100, wght: 700 })?.name).toBe("Bold");
  });

  it("treats an axis the location leaves out the same way", () => {
    expect(instanceAt(VARIABLE, { wght: 700 })?.name).toBe("Bold");
    expect(instanceAt(VARIABLE, { wdth: 75, wght: 700 })?.name).toBe(
      "Condensed Bold"
    );
  });

  it("finds nothing where the font names no instance", () => {
    expect(instanceAt(VARIABLE, { wdth: 100, wght: 640 })).toBeUndefined();
    expect(instanceAt(VARIABLE, {})).toBeUndefined();
  });
});
