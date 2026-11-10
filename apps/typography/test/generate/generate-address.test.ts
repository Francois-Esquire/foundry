import { describe, expect, it } from "vitest";
import { generateHash, readGeneratePath } from "~/generate/generate-address";
import { scopeFromKey, scopeOptionKey } from "~/generate/missing-characters";
import { nextStepsFor } from "~/generate/next-steps";
import {
  isScriptExtensionPath,
  SCRIPT_EXTENSION_HASH,
  scriptExtensionOffer,
} from "~/generate/script-extension/script-extension-address";
import { DEVANAGARI_SUBSET } from "~/generation/script-extension/devanagari-subset";

const LATIN = { code: "Latn", kind: "script" } as const;
const DIGITS = { group: "digits", kind: "shared" } as const;

describe("the Generate place's addresses", () => {
  it("writes a face and a writing system, and reads them back", () => {
    expect(generateHash("ab12:0@wght=400")).toBe(
      "#/generate/ab12%3A0%40wght%3D400"
    );
    expect(generateHash("ab12:0", LATIN)).toBe("#/generate/ab12%3A0/Latn");
    expect(readGeneratePath(["ab12:0", "Latn"])).toEqual({
      faceId: "ab12:0",
      scope: LATIN,
      unknownScope: undefined,
    });
    expect(readGeneratePath(["ab12:0", "shared.digits"]).scope).toEqual(DIGITS);
  });

  it("asks for nothing when bare, and keeps an unknown writing system to say so", () => {
    expect(readGeneratePath([])).toEqual({
      faceId: undefined,
      scope: undefined,
      unknownScope: undefined,
    });
    expect(readGeneratePath(["ab12:0", "Klingon"])).toMatchObject({
      scope: undefined,
      unknownScope: "Klingon",
    });
  });

  it("reads the face after the script extension's own segment", () => {
    expect(readGeneratePath(["script-extension"]).faceId).toBeUndefined();
    expect(readGeneratePath(["script-extension", "ab12:0"]).faceId).toBe(
      "ab12:0"
    );
  });

  it("names a writing system in the request the way its options do", () => {
    for (const scope of [LATIN, DIGITS]) {
      expect(scopeFromKey(scopeOptionKey(scope) ?? "")).toEqual(scope);
    }
    expect(scopeOptionKey({ kind: "block", name: "Basic Latin" })).toBe(
      undefined
    );
  });
});

describe("the script extension as another place may offer it", () => {
  it("is offered for the plan's script only, addressed to the face", () => {
    expect(scriptExtensionOffer("Latn", "ab12:0")).toBeUndefined();
    const offer = scriptExtensionOffer("Deva", "ab12:0");
    expect(offer?.hash).toBe(`${SCRIPT_EXTENSION_HASH}/ab12%3A0`);
    expect(isScriptExtensionPath(["script-extension", "ab12:0"])).toBe(true);
    expect(offer?.characters).toHaveLength(
      DEVANAGARI_SUBSET.glyphs.filter((glyph) => glyph.characters.length > 0)
        .length
    );
  });

  it("states the scope as a defined subset, and never as support for the script", () => {
    expect(scriptExtensionOffer("Deva", "ab12:0")?.statement).toBe(
      "This is a defined subset: 15 characters, 3 forms with no character of their own, and 9 test words. It is not support for Devanagari."
    );
  });
});

describe("where accepted candidates go next", () => {
  it("sets them as a text and names the one writing system they share", () => {
    expect(nextStepsFor([0x1_08, 0x1_09, 0x1_08])).toEqual({
      scope: LATIN,
      text: "Ĉ ĉ",
    });
  });

  it("names no writing system when they are of several, or when there are none", () => {
    expect(nextStepsFor([0x1_08, 0x3_91]).scope).toBeUndefined();
    expect(nextStepsFor([0x1_08, 0x31]).scope).toBeUndefined();
    expect(nextStepsFor([])).toEqual({ scope: undefined, text: "" });
  });
});
