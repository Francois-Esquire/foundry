import { describe, expect, it } from "vitest";
import { resultSections, scopeSections } from "~/explorer/sections";
import type { Classifier } from "~/unicode/coverage";

const basicOnly: Classifier = (codePoint) =>
  codePoint >= 0x9_00 && codePoint <= 0x9_7f ? "source" : "missing";

describe("scopeSections", () => {
  it("sections a script by block, in code point order, with what the face has", () => {
    const sections = scopeSections({ code: "Deva", kind: "script" }, basicOnly);
    expect(sections.map((section) => section.title)).toEqual([
      "Devanagari",
      "Devanagari Extended",
      "Devanagari Extended-A",
    ]);
    const [basic, extended] = sections;
    expect(basic?.detail).toBe("U+0900 to U+097F, 122 of 122 in the face");
    expect(extended?.detail).toBe("U+A8E0 to U+A8FF, 0 of 32 in the face");
    expect(basic?.characters[0]).toBe(0x9_00);
    expect(
      sections.reduce((sum, section) => sum + section.characters.length, 0)
    ).toBe(164);
  });

  it("works for a shared group the same way as for a script", () => {
    const sections = scopeSections(
      { group: "digits", kind: "shared" },
      () => "missing"
    );
    expect(sections[0]?.title).toBe("Basic Latin");
    expect([...(sections[0]?.characters ?? [])]).toEqual([
      0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    ]);
  });

  it("gives every section its own key", () => {
    const sections = scopeSections({ code: "Latn", kind: "script" }, basicOnly);
    expect(new Set(sections.map((section) => section.key)).size).toBe(
      sections.length
    );
  });
});

describe("resultSections", () => {
  it("keeps found characters in ranked order under one heading", () => {
    const [results] = resultSections([0x9_15, 0x41, 0x9_16], basicOnly);
    expect(results?.title).toBe("3 characters found");
    expect(results?.detail).toBe("2 of 3 in the face");
    expect([...(results?.characters ?? [])]).toEqual([0x9_15, 0x41, 0x9_16]);
  });

  it("counts one character in the singular and shows nothing for none", () => {
    expect(resultSections([0x9_15], basicOnly)[0]?.title).toBe(
      "1 character found"
    );
    expect(resultSections([], basicOnly)).toEqual([]);
  });
});
