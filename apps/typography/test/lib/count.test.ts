import { describe, expect, it } from "vitest";
import { count } from "~/lib/count";

describe("count", () => {
  it("says one of a thing in the singular and any other number in the plural", () => {
    expect(count(1, "glyph")).toBe("1 glyph");
    expect(count(0, "glyph")).toBe("0 glyphs");
    expect(count(12, "glyph")).toBe("12 glyphs");
  });

  it("takes the plural of a noun that does not form it with an s", () => {
    expect(count(1, "axis", "axes")).toBe("1 axis");
    expect(count(2, "axis", "axes")).toBe("2 axes");
    expect(count(0, "axis", "axes")).toBe("0 axes");
  });
});
