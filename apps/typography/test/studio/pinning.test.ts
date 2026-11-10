import { describe, expect, it } from "vitest";
import { instanceAt, styleNameAt } from "~/studio/pinning";
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

describe("naming a pinned instance", () => {
  it("uses the font's own name for a location it names", () => {
    expect(styleNameAt(VARIABLE, { wdth: 75, wght: 700 })).toBe(
      "Condensed Bold"
    );
  });

  it("treats an axis left out as sitting at its default", () => {
    expect(instanceAt(VARIABLE, { wdth: 100, wght: 700 })?.name).toBe("Bold");
  });

  it("names any other location by its axis values", () => {
    expect(styleNameAt(VARIABLE, { wght: 640 })).toBe("wght 640, wdth 100");
  });
});
