import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { withoutCharacters } from "~/generate/hidden-characters";
import { partsOf, planRequest, RUN_LIMIT } from "~/generate/request-plan";
import { addedGlyph, type GlyphRef, sourceGlyph } from "~/typeface/changes";
import { fontBytes } from "../helpers/fixtures";

const lato = harfBuzzReader.open(fontBytes("lato"));
const E_ACUTE = 0xe9;
const KA = 0x09_15;
/** The first of a long run of characters Lato lacks, none of which decomposes. */
const FIRST_HAN = 0x4e_00;
/** Devanagari nnna, which is na with a nukta. Lato has neither part. */
const NNNA = 0x09_29;

const inSource = (character: number): GlyphRef | undefined => {
  const glyphId = lato.glyphForCharacter(character);
  return glyphId === undefined ? undefined : sourceGlyph(glyphId);
};

describe("a face with characters hidden", () => {
  it("answers as if it lacked them and leaves the face underneath open", () => {
    const hidden = withoutCharacters(lato, [E_ACUTE]);
    expect(hidden.glyphForCharacter(E_ACUTE)).toBeUndefined();
    expect([...hidden.characters()]).not.toContain(E_ACUTE);
    expect(hidden.glyphForCharacter(0x65)).toBe(lato.glyphForCharacter(0x65));
    hidden.close();
    expect(lato.glyphForCharacter(E_ACUTE)).toBeDefined();
    expect(withoutCharacters(lato, [])).toBe(lato);
  });
});

describe("planning a request", () => {
  it("plans a character the face has as a holdout: hidden, redrawn, compared", () => {
    const plan = planRequest(lato, [E_ACUTE], inSource);
    const [target] = plan.targets;
    expect(plan.heldOut).toEqual([E_ACUTE]);
    expect(plan.face.glyphForCharacter(E_ACUTE)).toBeUndefined();
    expect(target?.replaces).toEqual(inSource(E_ACUTE));
    expect(target?.recipe).toMatchObject({ base: 0x65, kind: "composite" });
    expect(plan.holdouts.get(target?.key ?? "")).toEqual(
      lato.glyph(lato.glyphForCharacter(E_ACUTE) ?? 0)
    );
  });

  it("plans a missing character as an addition with nothing to compare", () => {
    const plan = planRequest(lato, [KA], inSource);
    expect(plan.heldOut).toEqual([]);
    expect(plan.holdouts.size).toBe(0);
    expect(plan.face).toBe(lato);
    expect(plan.targets).toMatchObject([{ characters: [KA], needs: [] }]);
    expect(plan.targets[0]?.replaces).toBeUndefined();
    expect(plan.targets.flatMap((target) => partsOf(target, lato))).toEqual([]);
  });

  it("redraws a glyph the project already added for the character", () => {
    const added = addedGlyph("earlier");
    const plan = planRequest(lato, [KA], (character) =>
      character === KA ? added : inSource(character)
    );
    expect(plan.targets[0]?.replaces).toEqual(added);
    expect(plan.heldOut).toEqual([]);
  });

  it("says what each target is built from and where each part comes from", () => {
    const plan = planRequest(lato, [E_ACUTE, NNNA], inSource);
    const parts = new Map(
      plan.targets.map((target) => [target.key, partsOf(target, plan.face)])
    );
    expect(parts.get("u+00e9")).toEqual([
      { character: 0x65, drawnBy: 0x65, role: "base" },
      {
        character: 0x03_01,
        drawnBy: lato.glyphForCharacter(0x03_01) === undefined ? 0xb4 : 0x03_01,
        role: "mark",
      },
    ]);
    // Lato has no Devanagari, so both parts are targets, made first.
    const order = plan.targets.map((target) => target.key);
    expect(order.at(-1)).toBe("u+0929");
    expect(order).toContain("u+0928");
    expect(order).toContain("u+093c");
    expect(parts.get("u+0929")).toEqual([
      { character: 0x09_28, drawnBy: undefined, role: "base" },
      { character: 0x09_3c, drawnBy: undefined, role: "mark" },
    ]);
  });

  it("takes one run's worth of characters and counts the rest", () => {
    const many = Array.from(
      { length: RUN_LIMIT + 5 },
      (_, index) => FIRST_HAN + index
    );
    const plan = planRequest(lato, [...many, ...many], inSource);
    expect(plan.targets).toHaveLength(RUN_LIMIT);
    expect(plan.deferred).toBe(5);
  });
});
