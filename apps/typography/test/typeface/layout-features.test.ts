import { describe, expect, it } from "vitest";
import {
  featureLabel,
  featureName,
  featureTags,
  isFeatureOn,
  withFeature,
} from "~/typeface/layout-features";

describe("layout features in words", () => {
  it("names registered features, numbered sets and variants", () => {
    expect(featureName("liga")).toBe("Standard ligatures");
    expect(featureName("ss03")).toBe("Stylistic set 3");
    expect(featureName("cv12")).toBe("Character variant 12");
    expect(featureName("zzzz")).toBeUndefined();
  });

  it("labels a feature with its tag and its name, and a tag with no name alone", () => {
    expect(featureLabel("liga")).toBe("liga, Standard ligatures");
    expect(featureLabel("ss03")).toBe("ss03, Stylistic set 3");
    expect(featureLabel("cv11")).toBe("cv11, Character variant 11");
    expect(featureLabel("zzzz")).toBe("zzzz");
  });

  it("gives a tag the name the feature registry gives it", () => {
    expect(featureName("aalt")).toBe("Access all alternates");
    expect(featureName("curs")).toBe("Cursive positioning");
    expect(featureName("cjct")).toBe("Conjunct forms");
  });
});

describe("the features a face has", () => {
  it("lists substitution and positioning tags once, in order", () => {
    const layout = {
      positioning: ["kern", "mark"],
      scripts: ["latn"],
      substitution: ["liga", "kern", "ss01"],
    };
    expect(featureTags(layout)).toEqual(["kern", "liga", "mark", "ss01"]);
  });

  it("lists every feature of a face once", () => {
    expect(
      featureTags({
        positioning: ["kern", "ccmp"],
        substitution: ["liga", "ccmp"],
      })
    ).toEqual(["ccmp", "kern", "liga"]);
  });

  it("lists the features the project wrote itself too", () => {
    const layout = {
      positioning: ["kern", "mark"],
      substitution: ["liga", "kern"],
    };
    expect(featureTags(layout, [])).toEqual(["kern", "liga", "mark"]);
    expect(
      featureTags(layout, [
        "feature akhn { sub a b by c; } akhn; feature liga { } liga;",
      ])
    ).toEqual(["akhn", "kern", "liga", "mark"]);
  });
});

describe("layout features as switches", () => {
  it("starts with the features a shaper applies by itself switched on", () => {
    expect(isFeatureOn({}, "liga")).toBe(true);
    expect(isFeatureOn({}, "kern")).toBe(true);
    expect(isFeatureOn({}, "akhn")).toBe(true);
    expect(isFeatureOn({}, "ss01")).toBe(false);
    expect(isFeatureOn({}, "smcp")).toBe(false);
  });

  it("starts a feature a script shaper drives itself switched on", () => {
    // The Library once left these out, so its switch said off while the text showed on.
    for (const tag of ["pstf", "fin2", "rvrn", "ljmo", "rtla"]) {
      expect(isFeatureOn({}, tag)).toBe(true);
      expect(withFeature({}, tag, true)).toEqual({});
      expect(withFeature({}, tag, false)).toEqual({ [tag]: false });
    }
  });

  it("records a switch away from the default", () => {
    expect(withFeature({}, "liga", false)).toEqual({ liga: false });
    expect(withFeature({}, "ss01", true)).toEqual({ ss01: true });
  });

  it("records only choices that differ from the default", () => {
    const off = withFeature({}, "liga", false);
    expect(off).toEqual({ liga: false });
    expect(isFeatureOn(off, "liga")).toBe(false);
    expect(withFeature(off, "liga", true)).toEqual({});
    expect(withFeature({}, "smcp", false)).toEqual({});
  });

  it("forgets a switch back to the default, so the shaper decides again", () => {
    expect(withFeature({ liga: false, ss01: true }, "liga", true)).toEqual({
      ss01: true,
    });
    expect(withFeature({ ss01: true }, "ss01", false)).toEqual({});
  });
});
