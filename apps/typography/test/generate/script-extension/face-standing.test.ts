import { describe, expect, it } from "vitest";
import {
  extensionInFace,
  faceStanding,
} from "~/generate/script-extension/face-standing";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import {
  type AddedGlyph,
  EMPTY_WORKING_FACE,
  type WorkingFace,
} from "~/typeface/changes";
import type { Face } from "~/typeface/face";
import { EMPTY_OUTLINE } from "~/typeface/outline";
import { fixtureFace } from "../../generation/helpers/glyphs";

const lato = fixtureFace("lato");
const face: Face = {
  description: lato.description,
  id: "lato-regular",
  index: 0,
  sourceId: "lato",
};

const added = (key: string, character: number): AddedGlyph => ({
  advance: 600,
  characters: [character],
  key,
  name: key,
  outline: EMPTY_OUTLINE,
  provenance: { origin: "manual" },
});

const workingWith = (glyphs: readonly AddedGlyph[]): WorkingFace => ({
  ...EMPTY_WORKING_FACE,
  added: glyphs,
  characters: new Map(
    glyphs.flatMap((glyph) =>
      glyph.characters.map((character): [number, string] => [
        character,
        glyph.key,
      ])
    )
  ),
});

const none = () => false;

describe("where a face stands with the plan", () => {
  it("lacks every planned character when the source font has none", () => {
    expect(
      faceStanding({ face, inSource: none, plan, working: EMPTY_WORKING_FACE })
    ).toEqual({ held: 0, kind: "lacking" });
  });

  it("is in the face once every glyph of the extension is among the added glyphs", () => {
    const working = workingWith([added("ka", 0x09_15), added("ta", 0x09_24)]);
    expect(
      faceStanding({
        extensionKeys: ["ka", "ta"],
        face,
        inSource: none,
        plan,
        working,
      })
    ).toEqual({ held: 2, kind: "in-face" });
    expect(extensionInFace(["ka", "ta", "na"], working)).toBe(false);
    expect(extensionInFace([], working)).toBe(false);
  });

  it("is not offered for a face whose source font has planned characters", () => {
    const standing = faceStanding({
      face,
      inSource: (character) => character === 0x09_15,
      plan,
      working: EMPTY_WORKING_FACE,
    });
    expect(standing).toMatchObject({ held: 1, kind: "not-offered" });
    expect(standing.kind === "not-offered" && standing.reason).toContain(
      "already has 1 of the plan's 15 characters in its source font"
    );
  });

  it("is not offered for a pinned instance, and says why", () => {
    const standing = faceStanding({
      face: { ...face, pinned: { location: { wght: 700 }, styleName: "Bold" } },
      inSource: none,
      plan,
      working: EMPTY_WORKING_FACE,
    });
    expect(standing.kind === "not-offered" && standing.reason).toContain(
      "offered for static faces only"
    );
  });

  it("is not offered while a planned character has a glyph added some other way", () => {
    const standing = faceStanding({
      extensionKeys: ["ka", "ta"],
      face,
      inSource: none,
      plan,
      working: workingWith([added("accepted-alone", 0x09_15)]),
    });
    expect(standing).toMatchObject({ held: 1, kind: "not-offered" });
    expect(standing.kind === "not-offered" && standing.reason).toContain(
      "1 character of the plan already has a glyph added"
    );
  });
});
