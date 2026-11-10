import { describe, expect, it } from "vitest";
import { specimenTextFor } from "~/studio/specimen-text";

const faceWith = (text: string) => {
  const codePoints = [...text].map((letter) => letter.codePointAt(0) ?? 0);
  return {
    characters: () => Uint32Array.from(codePoints.toSorted((a, b) => a - b)),
    glyphForCharacter: (codePoint: number) =>
      codePoints.includes(codePoint) ? 1 : undefined,
  };
};

const LATIN = faceWith(" Hamburgefonstivxyz&");

describe("the starting specimen line", () => {
  it("is the test word when the face can set it", () => {
    expect(specimenTextFor(LATIN, [0x61])).toBe("Hamburgefonstiv");
  });

  it("leads with the glyph's own character when the word lacks it", () => {
    expect(specimenTextFor(LATIN, [0x26])).toBe("&Hamburgefonstiv");
  });

  it("is the test word alone for a glyph with no character", () => {
    expect(specimenTextFor(LATIN, [])).toBe("Hamburgefonstiv");
  });

  it("uses the first letters of a face that cannot set the test word", () => {
    const hebrew = faceWith(" 1אבג");
    expect(specimenTextFor(hebrew, [0x5_d2])).toBe("אבג");
  });
});
