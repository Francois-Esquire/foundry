import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { planFamilyRequest } from "~/generate/family/family-plan";
import { sourceGlyph } from "~/typeface/changes";
import { fontBytes } from "../../helpers/fixtures";
import { ACCENTED, codes } from "./helpers/family-session";

describe("the plan of a coordinated run", () => {
  const face = harfBuzzReader.open(fontBytes("sofia"));
  const glyphFor = (character: number) => {
    const glyphId = face.glyphForCharacter(character);
    return glyphId === undefined ? undefined : sourceGlyph(glyphId);
  };

  it("plans the characters the face lacks and no holdout test", () => {
    const { alreadyInFace, plan } = planFamilyRequest(
      face,
      codes(ACCENTED),
      glyphFor
    );
    expect(alreadyInFace).toEqual([]);
    expect(plan.targets.map((target) => target.text)).toEqual([...ACCENTED]);
    expect(plan.heldOut).toEqual([]);
    expect(plan.holdouts.size).toBe(0);
    expect(plan.targets.every((target) => target.replaces === undefined)).toBe(
      true
    );
  });

  it("leaves out a character the face already has, and says which", () => {
    const { alreadyInFace, plan } = planFamilyRequest(
      face,
      codes("éĉéa"),
      glyphFor
    );
    expect(alreadyInFace).toEqual(codes("éa"));
    expect(plan.targets.map((target) => target.text)).toEqual(["ĉ"]);
    expect(plan.heldOut).toEqual([]);
  });

  it("plans nothing when every character is in the face", () => {
    const { alreadyInFace, plan } = planFamilyRequest(
      face,
      codes("abc"),
      glyphFor
    );
    expect(alreadyInFace).toEqual(codes("abc"));
    expect(plan.targets).toEqual([]);
  });
});
