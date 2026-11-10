/**
 * validateDerivedFont on fonts the engine really built, and on fonts that
 * were built or damaged so that one particular check has to fail.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import type { BuildRequest, FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import type { ShapingSample } from "~/packaging/shaping-retention";
import {
  type DerivedFontCheck,
  type DerivedFontCheckId,
  type DerivedFontReport,
  type DerivedFontValidation,
  validateDerivedFont,
} from "~/packaging/validation";
import { fontBytes, TRIANGLE } from "../helpers/fixtures";
import { withDamagedTable } from "./helpers/damage";
import { charactersOf, glyphOf, requestFor } from "./helpers/requests";

const CONJUNCT = "क्ष";

const outcomes = (report: DerivedFontReport) =>
  Object.fromEntries(report.checks.map((check) => [check.id, check.outcome]));

const checkOf = (
  report: DerivedFontReport,
  id: DerivedFontCheckId
): DerivedFontCheck => {
  const found = report.checks.find((check) => check.id === id);
  if (!found) {
    throw new Error(`The report has no ${id} check.`);
  }
  return found;
};

describe("validating a derived font", () => {
  const lato = fontBytes("lato");
  const devanagari = fontBytes("devanagari");
  let builder: FontBuilder;

  const validate = async (
    request: BuildRequest,
    samples: readonly (ShapingSample | string)[],
    overrides: Partial<DerivedFontValidation> = {}
  ) =>
    validateDerivedFont({
      builder,
      derived: (await builder.build(request)).bytes,
      reader: harfBuzzReader,
      request,
      samples: samples.map((sample) =>
        typeof sample === "string" ? { text: sample } : sample
      ),
      ...overrides,
    });

  beforeAll(async () => {
    builder = await nodeFontBuilder();
  });

  it("passes a Latin subset that keeps its ligatures", async () => {
    const request = requestFor(lato, {
      familyName: "Atlas Sans",
      subset: { characters: charactersOf("office AV") },
    });
    const report = await validate(request, ["office", "AV", "fi"]);
    expect(report.passed).toBe(true);
    expect(outcomes(report)).toEqual({
      browser: "not-run",
      coverage: "pass",
      engine: "pass",
      joining: "pass",
      reopen: "pass",
      shaping: "pass",
    });
    expect(checkOf(report, "reopen").message).toBe(
      "The font reopens as Atlas Sans, with 19 glyphs and 8 characters."
    );
    expect(checkOf(report, "coverage").message).toBe(
      "All 8 requested characters are in the font."
    );
    expect(checkOf(report, "shaping").details).toEqual([
      '"office" becomes 4 glyphs from 6 characters, as in the source.',
      '"AV" becomes 2 glyphs from 2 characters, as in the source.',
      '"fi" becomes 1 glyph from 2 characters, as in the source.',
    ]);
    expect(checkOf(report, "joining").message).toBe(
      "The font still forms the ligatures and conjuncts of all 2 sample texts that have them."
    );
  });

  it("passes a pinned Devanagari subset that keeps its conjunct", async () => {
    const request = requestFor(devanagari, {
      location: { wdth: 80, wght: 700 },
      styleName: "Condensed Bold",
      subset: { characters: charactersOf(CONJUNCT) },
    });
    const report = await validate(request, [CONJUNCT, `${CONJUNCT}ख`, "abc"]);
    expect(report.passed).toBe(true);
    expect(outcomes(report)).toMatchObject({
      joining: "pass",
      shaping: "pass",
    });
    expect(checkOf(report, "shaping").details).toEqual([
      `"${CONJUNCT}" becomes 1 glyph from 3 characters, as in the source.`,
      `"${CONJUNCT}" (the kept part of "${CONJUNCT}ख") becomes 1 glyph from 3 characters, as in the source.`,
      '"abc" was not checked, because the derived font keeps none of its characters.',
    ]);
  });

  it("compares with the source shaped without the features that were left out", async () => {
    const request = requestFor(lato, {
      subset: { characters: charactersOf("fiAV"), features: ["kern"] },
    });
    const report = await validate(request, ["fi", "AV"]);
    expect(report.passed).toBe(true);
    expect(outcomes(report)).toMatchObject({
      joining: "not-run",
      shaping: "pass",
    });
    expect(checkOf(report, "shaping").details[0]).toBe(
      '"fi" becomes 2 glyphs from 2 characters. The source joins these characters, but the feature that does it was not kept.'
    );
    expect(checkOf(report, "joining").message).toBe(
      "No sample text forms a ligature or conjunct in the source with the kept features, so this was not exercised."
    );
  });

  // Without akhn the conjunct glyph is not formed, but half still joins ka and
  // the virama into a half form: two glyphs, in the derived font and in the
  // source once akhn is switched off for the comparison.
  it("does the same for a script whose shaper applies its features itself", async () => {
    const request = requestFor(devanagari, {
      subset: {
        characters: charactersOf(CONJUNCT),
        features: ["half", "abvs", "blws", "pres", "psts"],
      },
    });
    const report = await validate(request, [CONJUNCT]);
    expect(harfBuzzReader.open(devanagari).shape(CONJUNCT).glyphs).toHaveLength(
      1
    );
    expect(outcomes(report)).toMatchObject({
      joining: "pass",
      shaping: "pass",
    });
    expect(checkOf(report, "shaping").details).toEqual([
      `"${CONJUNCT}" becomes 2 glyphs from 3 characters, as in the source.`,
    ]);
  });

  it("does not take a mark sharing its base's cluster for a ligature", async () => {
    const withVowelSign = "कि";
    const request = requestFor(devanagari, {
      location: { wght: 400 },
      subset: { characters: charactersOf(withVowelSign) },
    });
    const report = await validate(request, [withVowelSign]);
    expect(checkOf(report, "shaping").details).toEqual([
      `"${withVowelSign}" becomes 2 glyphs from 2 characters, as in the source.`,
    ]);
    expect(outcomes(report)).toMatchObject({
      joining: "not-run",
      shaping: "pass",
    });
  });

  it("fails coverage when a requested character is not in the font", async () => {
    const built = requestFor(lato, {
      subset: { characters: charactersOf("ab") },
    });
    const claimed = requestFor(lato, {
      subset: { characters: charactersOf("abcd") },
    });
    const report = await validate(built, ["ab"], { request: claimed });
    expect(report.passed).toBe(false);
    expect(outcomes(report)).toMatchObject({
      coverage: "fail",
      engine: "pass",
      shaping: "pass",
    });
    expect(checkOf(report, "coverage")).toMatchObject({
      details: ["Missing: U+0063, U+0064."],
      message: "2 of the 4 requested characters are not in the font.",
    });
  });

  it("checks every source character when nothing was subset", async () => {
    const request = requestFor(lato, { familyName: "Atlas Sans" });
    const report = await validate(request, []);
    const { characterCount } = harfBuzzReader.open(lato).description;
    expect(characterCount).toBeGreaterThan(2000);
    expect(checkOf(report, "coverage").message).toBe(
      `All ${characterCount} requested characters are in the font.`
    );
    expect(outcomes(report)).toMatchObject({
      joining: "not-run",
      shaping: "not-run",
    });
    expect(report.passed).toBe(true);
  });

  it("fails shaping when a ligature whose feature was kept is gone", async () => {
    const characters = charactersOf("fix");
    const built = requestFor(lato, { subset: { characters, features: [] } });
    const claimed = requestFor(lato, { subset: { characters } });
    const report = await validate(built, ["fix", "x"], { request: claimed });
    expect(report.passed).toBe(false);
    expect(outcomes(report)).toMatchObject({
      coverage: "pass",
      joining: "fail",
      shaping: "fail",
    });
    expect(checkOf(report, "shaping").message).toBe(
      "1 of 2 sample texts shape differently from the source."
    );
    expect(checkOf(report, "joining").details).toEqual([
      '"fix" becomes 3 glyphs in the derived font and 2 glyphs in the source.',
    ]);
  });

  it("takes the declared glyph count for text the project's own features change", async () => {
    const latoFace = harfBuzzReader.open(lato);
    const { glyphNames } = await builder.describeLayout(lato);
    const name = (character: string) =>
      glyphNames[glyphOf(latoFace, character)];
    const request = requestFor(lato, {
      added: [
        {
          advance: 1000,
          characters: [0xe0_00],
          key: "triangle",
          name: "triangle",
          outline: TRIANGLE,
          provenance: { origin: "manual" },
        },
      ],
      featureCode: [
        `languagesystem DFLT dflt; languagesystem latn dflt;
feature liga { sub ${name("a")} ${name("b")} by triangle; } liga;`,
      ],
      subset: { characters: [...charactersOf("abfi"), 0xe0_00] },
    });
    const declared = await validate(request, [
      { glyphCount: 1, text: "ab" },
      "fi",
    ]);
    expect(declared.passed).toBe(true);
    expect(checkOf(declared, "shaping").details[0]).toBe(
      '"ab" becomes 1 glyph, as the project\'s features intend.'
    );
    const undeclared = await validate(request, ["ab"]);
    expect(outcomes(undeclared)).toMatchObject({ shaping: "fail" });
    const wrong = await validate(request, [{ glyphCount: 2, text: "ab" }]);
    expect(checkOf(wrong, "shaping").details[0]).toBe(
      '"ab" becomes 1 glyph where the project\'s features should give 2.'
    );
  });

  it("unpacks a WOFF2 file before reopening it", async () => {
    const request = requestFor(lato, {
      flavor: "woff2",
      subset: { characters: charactersOf("fi") },
    });
    const report = await validate(request, ["fi"]);
    expect(report.passed).toBe(true);
    expect(checkOf(report, "reopen").message).toBe(
      "The font reopens after unpacking as Lato, with 8 glyphs and 2 characters."
    );
  });

  it("catches a damaged table the reader does not notice", async () => {
    const request = requestFor(lato, {
      subset: { characters: charactersOf("fi") },
    });
    const sound = (await builder.build(request)).bytes;
    const report = await validateDerivedFont({
      builder,
      derived: withDamagedTable(sound, "GPOS"),
      reader: harfBuzzReader,
      request,
      samples: [{ text: "fi" }],
    });
    expect(report.passed).toBe(false);
    expect(outcomes(report)).toMatchObject({ engine: "fail", reopen: "pass" });
    expect(checkOf(report, "engine").details[0]).toContain(
      "The GPOS table is damaged and cannot be read"
    );
  });

  it("reports a file that is not a font, and does not run the checks that need it open", async () => {
    const report = await validateDerivedFont({
      builder,
      derived: new TextEncoder().encode("not a font at all"),
      reader: harfBuzzReader,
      request: requestFor(lato),
      samples: [{ text: "fi" }],
    });
    expect(report.passed).toBe(false);
    expect(outcomes(report)).toEqual({
      browser: "not-run",
      coverage: "not-run",
      engine: "fail",
      joining: "not-run",
      reopen: "fail",
      shaping: "not-run",
    });
    expect(checkOf(report, "reopen").message).toBe(
      "The font does not reopen: This file is not a TrueType or OpenType font."
    );
  });

  it("never passes the checks against source shaping for a font built on an empty source", async () => {
    const blank = await builder.blankFont({
      familyName: "Storefront",
      metrics: { ascender: 800, descender: -200, lineGap: 0, unitsPerEm: 1000 },
      styleName: "Regular",
    });
    const letter = (name: string) => ({
      advance: 1000,
      characters: charactersOf(name),
      key: name,
      name,
      outline: TRIANGLE,
      provenance: {
        basis: "observed",
        evidenceId: "photograph",
        origin: "reconstructed",
      } as const,
    });
    // The empty source has a space and nothing else, so only the spaces of
    // these texts are in both fonts. Spaces compare nothing.
    const report = await validate(
      requestFor(blank.bytes, { added: [letter("A"), letter("V")] }),
      ["AV", "A V A", "V A"]
    );
    expect(outcomes(report)).toMatchObject({
      coverage: "pass",
      engine: "pass",
      joining: "not-run",
      reopen: "pass",
      shaping: "not-run",
    });
    expect(checkOf(report, "shaping").details).toContain(
      '"A V A" was not checked, because the source font draws none of its characters, so there is nothing to compare with.'
    );
  });

  it("runs the browser check it is given", async () => {
    const request = requestFor(lato, {
      subset: { characters: charactersOf("fi") },
    });
    const seen: Uint8Array[] = [];
    const accepted = await validate(request, ["fi"], {
      browserCheck: (font) => {
        seen.push(font);
        return Promise.resolve();
      },
    });
    expect(checkOf(accepted, "browser")).toMatchObject({
      message: "The browser loads the font.",
      outcome: "pass",
    });
    expect(seen[0]?.byteLength).toBeGreaterThan(0);
    const refused = await validate(request, ["fi"], {
      browserCheck: () =>
        Promise.reject(new Error("the sanitizer rejected the glyf table")),
    });
    expect(refused.passed).toBe(false);
    expect(checkOf(refused, "browser")).toMatchObject({
      message:
        "The browser does not load the font: the sanitizer rejected the glyf table",
      outcome: "fail",
    });
  });
});
