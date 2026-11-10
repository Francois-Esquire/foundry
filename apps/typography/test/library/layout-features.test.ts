import { describe, expect, it } from "vitest";
import {
  chooseFeature,
  featureName,
  featureTags,
  fontFeatureSettings,
  isFeatureOn,
} from "~/library/layout-features";

describe("layout features", () => {
  it("names registered features, numbered sets and variants", () => {
    expect(featureName("liga")).toBe("Standard ligatures");
    expect(featureName("ss03")).toBe("Stylistic set 3");
    expect(featureName("cv12")).toBe("Character variant 12");
    expect(featureName("zzzz")).toBeUndefined();
  });

  it("starts each feature where shaping leaves it", () => {
    expect(isFeatureOn({}, "liga")).toBe(true);
    expect(isFeatureOn({}, "akhn")).toBe(true);
    expect(isFeatureOn({}, "smcp")).toBe(false);
  });

  it("records only choices that differ from the default", () => {
    const off = chooseFeature({}, "liga", false);
    expect(off).toEqual({ liga: false });
    expect(isFeatureOn(off, "liga")).toBe(false);
    expect(chooseFeature(off, "liga", true)).toEqual({});
    expect(chooseFeature({}, "smcp", false)).toEqual({});
  });

  it("writes the choices as a CSS value, in tag order", () => {
    expect(fontFeatureSettings({})).toBe("normal");
    expect(fontFeatureSettings({ liga: false, smcp: true })).toBe(
      '"liga" 0, "smcp" 1'
    );
  });

  it("lists every feature of a face once", () => {
    expect(
      featureTags({
        positioning: ["kern", "ccmp"],
        substitution: ["liga", "ccmp"],
      })
    ).toEqual(["ccmp", "kern", "liga"]);
  });
});
