import { describe, expect, it } from "vitest";
import { consideredCharacters } from "~/reconstruct/considered-characters";
import {
  blankFileName,
  blankFontFor,
  familyNameFrom,
  metricsOf,
} from "~/reconstruct/destination";
import { referenceFaces, referencesKey } from "~/reconstruct/references";
import { fixtureFile, importOne, testWorkspace } from "../helpers/workspace";

describe("the library as references", () => {
  it("takes a static face once and a variable face at its regular weight and both ends", async () => {
    const workspace = testWorkspace();
    const lato = await importOne(workspace, fixtureFile("lato"));
    const sofia = await importOne(workspace, fixtureFile("sofia"));
    const references = referenceFaces(
      workspace.getState().project.faces,
      (face) => workspace.openFace(face.id),
      consideredCharacters("capitals")
    );
    expect(references.map((reference) => reference.name)).toEqual([
      "Lato Regular",
      "Sofia Sans at weight 400",
      "Sofia Sans at weight 1",
      "Sofia Sans at weight 1000",
    ]);
    expect(references.map((reference) => reference.location)).toEqual([
      undefined,
      { wght: 400 },
      { wght: 1 },
      { wght: 1000 },
    ]);
    expect(new Set(references.map((reference) => reference.id)).size).toBe(4);
    expect(references[0]?.id).toBe(lato.faceId);
    expect(referencesKey(references)).toContain(sofia.faceId);
  });

  it("leaves out a face that draws none of the characters", async () => {
    const workspace = testWorkspace();
    await importOne(workspace, fixtureFile("lato"));
    const references = referenceFaces(
      workspace.getState().project.faces,
      (face) => workspace.openFace(face.id),
      [0x09_15]
    );
    expect(references).toEqual([]);
    expect(referencesKey(references)).toBe("");
  });
});

describe("the face letters go to", () => {
  it("suggests a family name from the photograph's file name", () => {
    expect(familyNameFrom("storefront-needed-things.jpg")).toBe(
      "Storefront Needed Things"
    );
    expect(familyNameFrom("IMG_0042.JPG")).toBe("IMG 0042");
    expect(familyNameFrom(".png")).toBe("Reconstruction");
  });

  it("asks for an empty font on the lines letters are recovered to", () => {
    expect(blankFontFor("  Storefront  ")).toEqual({
      familyName: "Storefront",
      metrics: {
        ascender: 800,
        capHeight: 700,
        descender: -200,
        lineGap: 0,
        unitsPerEm: 1000,
        xHeight: 500,
      },
      styleName: "Regular",
    });
    expect(blankFileName("Storefront Needed Things")).toBe(
      "StorefrontNeededThings-Regular.ttf"
    );
  });

  it("fills in the lines a face does not declare", () => {
    expect(
      metricsOf({
        ascender: 1900,
        descender: -500,
        lineGap: 0,
        unitsPerEm: 2000,
      })
    ).toEqual({
      ascender: 1900,
      capHeight: 1400,
      descender: -500,
      unitsPerEm: 2000,
      xHeight: 1000,
    });
    expect(
      metricsOf({
        ascender: 800,
        capHeight: 716,
        descender: -200,
        lineGap: 0,
        unitsPerEm: 1000,
        xHeight: 506,
      })
    ).toMatchObject({ capHeight: 716, xHeight: 506 });
  });
});
