/** Pinned instances of a project resolved into a request to rebuild a variable font. */
import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { resolveExportPlan } from "~/packaging/resolving";
import { resolveVariableBuild } from "~/packaging/variable-build";
import { commit, pinInstance } from "~/typeface/project";
import { stamp } from "../helpers/fixed";
import { FONTS, fontBytes } from "../helpers/fixtures";
import { addedWedge } from "./helpers/masters";
import { expectPlainSentences } from "./helpers/messages";
import { fakeLookups, importFace, startProject } from "./helpers/projects";

describe("resolving a variable build", () => {
  const sofia = fontBytes("sofia");
  const sofiaFace = harfBuzzReader.open(sofia);
  const imported = startProject(FONTS.sofia, sofiaFace.description, sofia);
  const light = pinInstance(
    imported.project,
    imported.faceId,
    { wght: 300 },
    "Light"
  );
  const bold = pinInstance(
    light.project,
    imported.faceId,
    { wght: 700 },
    "Bold"
  );
  const project = commit(bold.project, {
    ...stamp(),
    changes: [
      { faceId: light.face.id, glyph: addedWedge(250), kind: "glyph-added" },
      { faceId: bold.face.id, glyph: addedWedge(450), kind: "glyph-added" },
      {
        code: "feature ss20 { sub a by wedge; } ss20;",
        description: "Wedge for a",
        faceId: bold.face.id,
        kind: "features-added",
      },
    ],
    label: "Add a wedge to both masters",
  });
  const masters = [light.face.id, bold.face.id];
  const codes = (findings: readonly { readonly code: string }[]) =>
    findings.map((finding) => finding.code);

  it("makes one master per pinned instance, with its working face", () => {
    const resolution = resolveVariableBuild(project, masters, {
      familyName: " Atlas Sans ",
      flavor: "woff2",
    });
    expect(resolution.problems).toEqual([]);
    expect(resolution.warnings).toEqual([]);
    expect(resolution.fileName).toBe("AtlasSans-VariableRebuilt.woff2");
    expect(resolution.request).toMatchObject({
      faceIndex: 0,
      familyName: "Atlas Sans",
      flavor: "woff2",
      masters: [
        {
          added: [{ advance: 450, name: "wedge" }],
          featureCode: [],
          location: { wght: 300 },
          styleName: "Light",
        },
        {
          added: [{ advance: 650, name: "wedge" }],
          featureCode: ["feature ss20 { sub a by wedge; } ss20;"],
          location: { wght: 700 },
          styleName: "Bold",
        },
      ],
    });
    expect(resolution.request?.source).toBe(sofia);
  });

  it("names the rebuilt font apart from the variable face exported as it is", () => {
    const familyName = "Atlas Sans";
    const kept = resolveExportPlan(
      project,
      {
        characters: { kind: "everything" },
        faces: [{ faceId: imported.faceId }],
        familyName,
        features: { kind: "needed" },
        format: "ttf",
      },
      fakeLookups({})
    );
    const rebuilt = resolveVariableBuild(project, masters, { familyName });
    expect(kept.outputs.map((output) => output.fileName)).toEqual([
      "AtlasSans-Variable.ttf",
    ]);
    expect(rebuilt.fileName).toBe("AtlasSans-VariableRebuilt.ttf");
  });

  it("warns when the rebuilt font keeps the source's family name", () => {
    const resolution = resolveVariableBuild(project, masters);
    expect(resolution.request?.familyName).toBeUndefined();
    expect(resolution.fileName).toBe("SofiaSans-VariableRebuilt.ttf");
    expect(codes(resolution.warnings)).toEqual(["family-name-kept"]);
    expectPlainSentences(resolution.warnings.map((found) => found.message));
  });

  it("blocks a family name the licence reserves", () => {
    const reserving = startProject(
      FONTS.sofia,
      {
        ...sofiaFace.description,
        licence: {
          copyright:
            'Copyright 2019 The Sofia Sans Project Authors, with Reserved Font Name "Sofia". Licensed under the SIL Open Font License.',
          embedding: 0,
        },
      },
      sofia
    );
    const first = pinInstance(
      reserving.project,
      reserving.faceId,
      { wght: 300 },
      "Light"
    );
    const second = pinInstance(
      first.project,
      reserving.faceId,
      { wght: 700 },
      "Bold"
    );
    const resolution = resolveVariableBuild(
      second.project,
      [first.face.id, second.face.id],
      { familyName: "Sofia Rebuilt" }
    );
    expect(codes(resolution.problems)).toEqual(["reserved-font-name"]);
    expect(resolution.request).toBeUndefined();
  });

  it("refuses fewer than two masters", () => {
    const resolution = resolveVariableBuild(project, [light.face.id], {
      familyName: "Atlas Sans",
    });
    expect(codes(resolution.problems)).toEqual(["too-few-masters"]);
    expect(resolution.request).toBeUndefined();
    expect(codes(resolveVariableBuild(project, []).problems)).toEqual([
      "too-few-masters",
    ]);
  });

  it("counts a face named twice as one master", () => {
    const resolution = resolveVariableBuild(
      project,
      [light.face.id, light.face.id],
      { familyName: "Atlas Sans" }
    );
    expect(codes(resolution.problems)).toEqual(["too-few-masters"]);
  });

  it("refuses a face that is not a pinned instance, or not in the project", () => {
    const resolution = resolveVariableBuild(
      project,
      [imported.faceId, light.face.id, "missing"],
      { familyName: "Atlas Sans" }
    );
    expect(codes(resolution.problems)).toEqual([
      "not-pinned",
      "unknown-face",
      "too-few-masters",
    ]);
    expect(resolution.problems[0]?.message).toBe(
      "Sofia Sans Regular is not a pinned instance. A master is a pinned instance of a variable face."
    );
    expectPlainSentences(resolution.problems.map((found) => found.message));
  });

  it("refuses masters from different source fonts", () => {
    const devanagari = fontBytes("devanagari");
    const other = importFace(
      project,
      FONTS.devanagari,
      harfBuzzReader.open(devanagari).description,
      devanagari
    );
    const pinned = pinInstance(
      other.project,
      other.faceId,
      { wght: 700 },
      "Bold"
    );
    const resolution = resolveVariableBuild(
      pinned.project,
      [light.face.id, pinned.face.id],
      { familyName: "Atlas Sans" }
    );
    expect(codes(resolution.problems)).toEqual(["several-sources"]);
    expect(resolution.problems[0]?.message).toBe(
      "Noto Sans Devanagari Bold and Sofia Sans Light come from different source fonts. Masters are pinned instances of one variable face."
    );
  });

  it("refuses masters that differ on more than one axis", () => {
    const devanagari = fontBytes("devanagari");
    const started = startProject(
      FONTS.devanagari,
      harfBuzzReader.open(devanagari).description,
      devanagari
    );
    const regular = pinInstance(
      started.project,
      started.faceId,
      { wght: 400 },
      "Regular"
    );
    const narrow = pinInstance(
      regular.project,
      started.faceId,
      { wdth: 75, wght: 700 },
      "Condensed Bold"
    );
    const heavy = pinInstance(
      narrow.project,
      started.faceId,
      { wdth: 100, wght: 900 },
      "Black"
    );
    const options = { familyName: "Atlas Devanagari" };
    const crooked = resolveVariableBuild(
      heavy.project,
      [regular.face.id, narrow.face.id],
      options
    );
    expect(codes(crooked.problems)).toEqual(["several-axes"]);
    expect(crooked.problems[0]?.message).toBe(
      "The masters differ on more than one axis (wght, wdth). Pin them along one axis and keep the others the same."
    );
    const straight = resolveVariableBuild(
      heavy.project,
      [regular.face.id, heavy.face.id],
      options
    );
    expect(straight.problems).toEqual([]);
    expect(straight.request?.masters.map((master) => master.location)).toEqual([
      { wdth: 100, wght: 400 },
      { wdth: 100, wght: 900 },
    ]);
  });

  it("refuses an empty family name", () => {
    const resolution = resolveVariableBuild(project, masters, {
      familyName: "  ",
    });
    expect(codes(resolution.problems)).toEqual(["empty-family-name"]);
  });
});
