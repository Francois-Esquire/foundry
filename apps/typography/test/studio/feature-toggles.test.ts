import { describe, expect, it } from "vitest";
import {
  featureTags,
  isFeatureOn,
  withFeature,
} from "~/studio/feature-toggles";

describe("layout features as switches", () => {
  it("lists substitution and positioning tags once, in order", () => {
    expect(
      featureTags({
        positioning: ["kern", "mark"],
        scripts: ["latn"],
        substitution: ["liga", "kern", "ss01"],
      })
    ).toEqual(["kern", "liga", "mark", "ss01"]);
  });

  it("starts with the features a shaper applies by itself switched on", () => {
    expect(isFeatureOn({}, "liga")).toBe(true);
    expect(isFeatureOn({}, "kern")).toBe(true);
    expect(isFeatureOn({}, "akhn")).toBe(true);
    expect(isFeatureOn({}, "ss01")).toBe(false);
    expect(isFeatureOn({}, "smcp")).toBe(false);
  });

  it("records a switch away from the default", () => {
    expect(withFeature({}, "liga", false)).toEqual({ liga: false });
    expect(withFeature({}, "ss01", true)).toEqual({ ss01: true });
  });

  it("forgets a switch back to the default, so the shaper decides again", () => {
    expect(withFeature({ liga: false, ss01: true }, "liga", true)).toEqual({
      ss01: true,
    });
    expect(withFeature({ ss01: true }, "ss01", false)).toEqual({});
  });
});
