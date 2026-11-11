import { describe, expect, it } from "vitest";
import { fontFeatureSettings } from "~/library/layout-features";

describe("layout feature choices for the browser", () => {
  it("writes the choices as a CSS value, in tag order", () => {
    expect(fontFeatureSettings({})).toBe("normal");
    expect(fontFeatureSettings({ liga: false, smcp: true })).toBe(
      '"liga" 0, "smcp" 1'
    );
  });
});
