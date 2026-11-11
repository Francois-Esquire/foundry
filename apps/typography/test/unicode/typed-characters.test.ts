import { describe, expect, it } from "vitest";
import {
  charactersTyped,
  readTypedCharacters,
} from "~/unicode/typed-characters";

describe("reading a typed list of characters", () => {
  it("takes typed characters in order, once each, ignoring spaces and commas", () => {
    expect(readTypedCharacters(" é è,ñ é ")).toEqual([0xe9, 0xe8, 0xf1]);
  });

  it("reads code point notation and leaves bare hex digits as letters", () => {
    expect(readTypedCharacters("U+00E9 0x915 u+1F600")).toEqual([
      0xe9, 0x9_15, 0x1_f6_00,
    ]);
    // "a" and "0915" are characters to draw, not code points.
    expect(readTypedCharacters("a 09")).toEqual([0x61, 0x30, 0x39]);
  });

  it("reads a base letter with a combining mark as the one accented character", () => {
    expect(readTypedCharacters("é")).toEqual([0xe9]);
  });

  it("drops characters that draw nothing", () => {
    expect(readTypedCharacters("a​b \tc")).toEqual([0x61, 0x62, 0x63]);
    expect(readTypedCharacters("")).toEqual([]);
  });
});

describe("reading a typed text for its characters", () => {
  it("keeps every distinct character typed, spaces included, astral ones whole", () => {
    expect(charactersTyped("a b\na😀")).toEqual([0x61, 0x20, 0x62, 0x1_f6_00]);
  });
});
