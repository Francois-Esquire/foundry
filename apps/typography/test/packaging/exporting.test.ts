/**
 * A plan carried through to files: resolved against a real project, built by
 * the engine, and validated. This is the path the export screen takes.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { BuildError, type FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import type { CharacterLookups, ExportPlan } from "~/packaging/export-plan";
import { exportFonts } from "~/packaging/exporting";
import { resolveExportPlan } from "~/packaging/resolving";
import { validateDerivedFont } from "~/packaging/validation";
import { sourceGlyph } from "~/typeface/changes";
import { commit, pinInstance } from "~/typeface/project";
import { FONTS, fontBytes } from "../helpers/fixtures";
import { importFace, span, startProject } from "./helpers/projects";
import { glyphOf } from "./helpers/requests";

const CONJUNCT = "क्ष";

const refusingBuilder: FontBuilder = {
  blankFont: () => Promise.reject(new Error("Nothing should be built.")),
  build: () => Promise.reject(new Error("Nothing should be built.")),
  buildVariable: () => Promise.reject(new Error("Nothing should be built.")),
  describeLayout: () => Promise.reject(new Error("Nothing should be read.")),
  validate: () => Promise.reject(new Error("Nothing should be validated.")),
};

describe("carrying out an export plan", () => {
  const lato = fontBytes("lato");
  const devanagari = fontBytes("devanagari");
  const latoFace = harfBuzzReader.open(lato);
  const devanagariFace = harfBuzzReader.open(devanagari);
  const imported = startProject(FONTS.lato, latoFace.description, lato);
  const second = importFace(
    imported.project,
    FONTS.devanagari,
    devanagariFace.description,
    devanagari
  );
  const pinned = pinInstance(
    second.project,
    second.faceId,
    { wght: 700 },
    "Bold"
  );
  const project = commit(pinned.project, {
    changes: [
      {
        advance: 1500,
        faceId: imported.faceId,
        glyph: sourceGlyph(glyphOf(latoFace, "a")),
        kind: "advance-changed",
      },
    ],
    label: "Widen a",
  });
  const lookups: CharacterLookups = {
    charactersOfBlock: () => [],
    charactersOfFace: (faceId) =>
      faceId === imported.faceId
        ? latoFace.characters()
        : devanagariFace.characters(),
    charactersOfLanguage: () => [],
    charactersOfScript: (script) =>
      script === "Deva" ? span(0x09_00, 0x09_7f) : span(0x41, 0x7a),
  };
  const plan: ExportPlan = {
    characters: {
      kind: "selected",
      selectors: [
        { kind: "script", script: "Deva" },
        { kind: "script", script: "Latn" },
      ],
    },
    faces: [{ faceId: imported.faceId }, { faceId: pinned.face.id }],
    familyName: "Atlas",
    features: { kind: "needed" },
    format: "woff2",
  };
  let builder: FontBuilder;

  beforeAll(async () => {
    builder = await nodeFontBuilder();
  });

  it("refuses to build while the plan has problems", async () => {
    const blocked = resolveExportPlan(
      project,
      { ...plan, familyName: undefined },
      lookups
    );
    expect(blocked.problems.map((problem) => problem.code)).toEqual([
      "reserved-font-name",
    ]);
    const error = await exportFonts(builder, blocked).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(BuildError);
    expect((error as Error).message).toBe(blocked.problems[0]?.message);
  });

  it("passes an untouched source through without the engine", async () => {
    const resolution = resolveExportPlan(
      project,
      {
        characters: { kind: "everything" },
        faces: [{ faceId: second.faceId }],
        features: { kind: "needed" },
        format: "ttf",
      },
      lookups
    );
    const [exported] = await exportFonts(refusingBuilder, resolution);
    expect(exported?.bytes).toBe(devanagari);
    expect(exported?.fileName).toBe(FONTS.devanagari);
    expect(exported?.notes).toEqual([]);
  });

  it("builds one validated file per face, named as predicted", async () => {
    const resolution = resolveExportPlan(project, plan, lookups);
    expect(resolution.problems).toEqual([]);
    // Lato has no Devanagari. The Devanagari font has the Latin letters too.
    expect(
      resolution.warnings.map((warning) => [warning.code, warning.faceId])
    ).toEqual([["characters-missing", imported.faceId]]);
    const exported = await exportFonts(builder, resolution);
    expect(exported.map((font) => font.fileName)).toEqual([
      "Atlas-Regular-subset.woff2",
      "Atlas-Bold-subset.woff2",
    ]);
    expect(exported[1]?.notes).toEqual([
      "Pinned the variable font to one instance.",
    ]);

    for (const font of exported) {
      if (font.output.kind !== "derived") {
        throw new Error("Both outputs are derived fonts.");
      }
      const report = await validateDerivedFont({
        builder,
        derived: font.bytes,
        reader: harfBuzzReader,
        request: font.output.request,
        samples: [{ text: "office" }, { text: CONJUNCT }, { text: "AV" }],
      });
      expect(report.checks.filter((check) => check.outcome === "fail")).toEqual(
        []
      );
      expect(report.passed).toBe(true);
      expect(
        report.checks.find((check) => check.id === "joining")?.outcome
      ).toBe("pass");
    }
  });
});
