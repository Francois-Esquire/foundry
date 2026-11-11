import { describe, expect, it } from "vitest";
import { codePointDigits, formatCodePoint } from "~/lib/code-point";

describe("a code point in writing", () => {
  it("is U+ and at least four capital hex digits", () => {
    expect(formatCodePoint(0x41)).toBe("U+0041");
    expect(formatCodePoint(0x09_15)).toBe("U+0915");
    expect(formatCodePoint(0x1_f6_00)).toBe("U+1F600");
  });

  it("prints its digits alone for a place that says U+ itself", () => {
    expect(codePointDigits(0xe9)).toBe("00E9");
    expect(codePointDigits(0x1_f6_00)).toBe("1F600");
  });
});
