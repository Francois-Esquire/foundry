import { describe, expect, it } from "vitest";
import type {
  CharacterSelection,
  CharacterSelector,
  ExportPlan,
  FeatureSelection,
  VariableTreatment,
} from "~/packaging/export-plan";
import {
  type ExportFinding,
  type ExportFindingCode,
  type ExportOutput,
  type ExportResolution,
  resolveExportPlan,
} from "~/packaging/resolving";
import type { FaceDescription, LicenceNotice } from "~/typeface/face";
import {
  addSource,
  commit,
  emptyProject,
  pinInstance,
  type TypefaceProject,
} from "~/typeface/project";
import { stamp } from "../helpers/fixed";
import { describeFace, TRIANGLE } from "../helpers/fixtures";
import { expectPlainSentences } from "./helpers/messages";
import {
  fakeLookups,
  importFace,
  span,
  startProject,
  withAnEdit,
} from "./helpers/projects";

const OFL: LicenceNotice = {
  description:
    "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
  embedding: 0,
};

const RESERVING: LicenceNotice = {
  ...OFL,
  copyright: 'Copyright 2011 Example with Reserved Font Name "Lato".',
};

const WEIGHT = {
  default: 400,
  max: 900,
  min: 100,
  name: "Weight",
  tag: "wght",
};

const LATIN = span(0x20, 0x7e);

const plain = (overrides: Partial<FaceDescription> = {}) =>
  describeFace({ licence: OFL, ...overrides });

const variable = () =>
  plain({
    axes: [WEIGHT],
    familyName: "Flex",
    instances: [{ location: { wght: 700 }, name: "Bold" }],
  });

const planFor = (
  faceIds: readonly string[],
  overrides: Partial<ExportPlan> = {}
): ExportPlan => ({
  characters: { kind: "everything" },
  faces: faceIds.map((faceId) => ({ faceId })),
  features: { kind: "needed" },
  format: "ttf",
  ...overrides,
});

const KEEP_VARIABLE: VariableTreatment = { kind: "keep-variable" };

const chosen = (...tags: string[]): FeatureSelection => ({
  kind: "chosen",
  tags,
});

const selected = (
  ...selectors: readonly CharacterSelector[]
): CharacterSelection => ({ kind: "selected", selectors });

const codes = (findings: readonly ExportFinding[]): ExportFindingCode[] =>
  findings.map((finding) => finding.code);

const derivedOf = (resolution: ExportResolution, index = 0) => {
  const output = resolution.outputs[index];
  if (output?.kind !== "derived") {
    throw new Error(`Output ${index} is not a derived font.`);
  }
  return output;
};

const resolveOne = (
  project: TypefaceProject,
  faceId: string,
  overrides: Partial<ExportPlan> = {},
  characters: readonly number[] = LATIN
) =>
  resolveExportPlan(
    project,
    planFor([faceId], overrides),
    fakeLookups({ [faceId]: characters })
  );

describe("exporting the original", () => {
  it("hands back the source file untouched, whatever its licence", () => {
    const bytes = new Uint8Array([9, 8, 7]);
    for (const licence of [OFL, RESERVING, { embedding: 0x00_02 }]) {
      const { faceId, project } = startProject(
        "Lato-Regular.ttf",
        plain({ familyName: "Lato", licence }),
        bytes
      );
      const resolution = resolveOne(project, faceId);
      expect(resolution).toEqual({
        outputs: [
          { bytes, faceId, fileName: "Lato-Regular.ttf", kind: "original" },
        ],
        problems: [],
        warnings: [],
      });
      expect(
        resolution.outputs[0]?.kind === "original" &&
          resolution.outputs[0].bytes
      ).toBe(bytes);
    }
  });

  it("treats a plan that names the family as it already is as unchanged", () => {
    const { faceId, project } = startProject(
      "Lato-Regular.ttf",
      plain({ familyName: "Lato" })
    );
    const resolution = resolveOne(project, faceId, { familyName: " Lato " });
    expect(resolution.outputs[0]?.kind).toBe("original");
  });

  it("builds a derived font as soon as anything differs", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    const differing: Partial<ExportPlan>[] = [
      { format: "woff2" },
      { familyName: "Other" },
      { features: chosen("kern") },
      {
        characters: {
          kind: "selected",
          selectors: [{ codePoints: [0x41], kind: "characters" }],
        },
      },
    ];
    for (const overrides of differing) {
      expect(resolveOne(project, faceId, overrides).outputs[0]?.kind).toBe(
        "derived"
      );
    }
    expect(
      resolveOne(withAnEdit(project, faceId), faceId).outputs[0]?.kind
    ).toBe("derived");
  });
});

describe("the build request", () => {
  it("carries the working face, the source bytes and the plan", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { faceId, project } = startProject("Specimen.ttf", plain(), bytes);
    const resolution = resolveOne(withAnEdit(project, faceId), faceId, {
      familyName: "Atlas Sans",
      format: "woff2",
    });
    const output = derivedOf(resolution);
    expect(resolution.problems).toEqual([]);
    expect(resolution.warnings).toEqual([]);
    expect(output.fileName).toBe("AtlasSans-Regular.woff2");
    expect(output.request).toEqual({
      added: [],
      faceIndex: 0,
      familyName: "Atlas Sans",
      featureCode: [],
      flavor: "woff2",
      location: undefined,
      overrides: new Map([[1, { advance: 640 }]]),
      source: bytes,
      styleName: undefined,
      subset: undefined,
    });
    expect(output.request.source).toBe(bytes);
  });

  it("warns when a derived font keeps the family name", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    const resolution = resolveOne(withAnEdit(project, faceId), faceId);
    expect(resolution.problems).toEqual([]);
    expect(codes(resolution.warnings)).toEqual(["family-name-kept"]);
    expect(derivedOf(resolution).request.familyName).toBeUndefined();
    expect(derivedOf(resolution).fileName).toBe("Specimen-Regular.ttf");
  });
});

describe("licences", () => {
  const lato = () =>
    startProject(
      "Lato-Regular.ttf",
      plain({ familyName: "Lato", licence: RESERVING })
    );

  it("blocks a modified font that keeps a reserved name", () => {
    const { faceId, project } = lato();
    const edited = withAnEdit(project, faceId);
    for (const familyName of [undefined, "Lato Derived", "My lato"]) {
      const resolution = resolveOne(edited, faceId, { familyName });
      expect(codes(resolution.problems)).toEqual(["reserved-font-name"]);
      expect(resolution.problems[0]?.faceId).toBe(faceId);
      expect(resolution.warnings).toEqual([]);
    }
  });

  it("blocks a subset or a compressed copy that keeps a reserved name", () => {
    const { faceId, project } = lato();
    const subset = resolveOne(project, faceId, {
      characters: {
        kind: "selected",
        selectors: [{ first: 0x41, kind: "range", last: 0x5a }],
      },
    });
    expect(codes(subset.problems)).toEqual(["reserved-font-name"]);
    expect(
      codes(resolveOne(project, faceId, { format: "woff2" }).problems)
    ).toEqual(["reserved-font-name"]);
  });

  it("lets the export through once the name is gone", () => {
    const { faceId, project } = lato();
    const resolution = resolveOne(withAnEdit(project, faceId), faceId, {
      familyName: "Atlas Sans",
    });
    expect(resolution.problems).toEqual([]);
    expect(resolution.warnings).toEqual([]);
  });

  it("warns about an unknown licence and restricted embedding without blocking", () => {
    const { faceId, project } = startProject(
      "Specimen.ttf",
      describeFace({ licence: { embedding: 0x01_02 } })
    );
    const resolution = resolveOne(project, faceId, {
      characters: {
        kind: "selected",
        selectors: [{ codePoints: [0x41], kind: "characters" }],
      },
      familyName: "Atlas Sans",
    });
    expect(resolution.problems).toEqual([]);
    expect(codes(resolution.warnings)).toEqual([
      "unknown-licence",
      "restricted-embedding",
      "no-subsetting",
    ]);
  });
});

describe("a face reconstructed from a photograph", () => {
  /** A face on an empty font the app made, with one accepted letter on it. */
  const reconstructed = (madeFor?: "reconstruction") => {
    const project = addSource(
      emptyProject(),
      {
        bytes: new Uint8Array([1, 2, 3]),
        fileName: "Storefront-Regular.ttf",
        id: "storefront".padEnd(64, "0"),
        importedAt: "2026-11-10T09:00:00.000Z",
        madeFor,
      },
      // The empty font names no licence at all.
      [describeFace({ familyName: "Storefront", licence: { embedding: 0 } })]
    );
    const faceId = project.faces[0]?.id ?? "";
    return {
      faceId,
      project: commit(project, {
        ...stamp(),
        changes: [
          {
            faceId,
            glyph: {
              advance: 1000,
              characters: [0x41],
              key: "letter-a",
              name: "A",
              outline: TRIANGLE,
              provenance: {
                basis: "observed",
                evidenceId: "photograph",
                origin: "reconstructed",
              },
            },
            kind: "glyph-added",
          },
        ],
        label: "Accept A",
      }),
    };
  };

  it("is warned about the lettering, not about a licence or a name it never had", () => {
    const { faceId, project } = reconstructed("reconstruction");
    const resolution = resolveOne(project, faceId);
    expect(resolution.problems).toEqual([]);
    expect(codes(resolution.warnings)).toEqual(["reconstructed-lettering"]);
    expect(resolution.warnings[0]).toEqual({
      code: "reconstructed-lettering",
      faceId,
      message:
        "The letters of Storefront Regular were reconstructed from a photograph. This app cannot know whether that lettering is a typeface someone owns. Check before you distribute the font.",
    });
    expectPlainSentences(resolution.warnings.map(({ message }) => message));
    // Renamed or not, the warning stays: it is about the letters.
    expect(
      codes(resolveOne(project, faceId, { familyName: "Atlas" }).warnings)
    ).toEqual(["reconstructed-lettering"]);
  });

  it("keeps both warnings for the same font when a person imported it", () => {
    const { faceId, project } = reconstructed();
    expect(codes(resolveOne(project, faceId).warnings)).toEqual([
      "unknown-licence",
      "family-name-kept",
    ]);
  });
});

describe("characters", () => {
  const select = (
    selectors: readonly CharacterSelector[]
  ): Partial<ExportPlan> => ({
    characters: selected(...selectors),
    familyName: "Atlas Sans",
  });

  it("joins code points, ranges, scripts, blocks and languages, narrowed to the face", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    const faceCharacters = [
      0x41, 0x42, 0x43, 0x7a, 0x03_91, 0x09_15, 0x09_37, 0x20_ac,
    ];
    const resolution = resolveOne(
      project,
      faceId,
      select([
        { codePoints: [0x20_ac, 0x41], kind: "characters" },
        { first: 0x42, kind: "range", last: 0x43 },
        { kind: "script", script: "Grek" },
        { block: "Basic Latin", kind: "block" },
        { kind: "language", language: "hi" },
      ]),
      faceCharacters
    );
    expect(resolution.problems).toEqual([]);
    expect(derivedOf(resolution).request.subset).toEqual({
      characters: [0x41, 0x42, 0x43, 0x7a, 0x03_91, 0x09_15, 0x09_37, 0x20_ac],
      features: undefined,
    });
    expect(derivedOf(resolution).fileName).toBe("AtlasSans-Regular-subset.ttf");
  });

  it("warns about selected characters the face does not have", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    const resolution = resolveOne(
      project,
      faceId,
      select([{ kind: "language", language: "hi" }]),
      [0x09_15]
    );
    expect(derivedOf(resolution).request.subset?.characters).toEqual([0x09_15]);
    expect(resolution.warnings).toEqual([
      {
        code: "characters-missing",
        faceId,
        message:
          "Specimen Regular does not have 2 of the 3 selected characters (U+0937, U+094D). They are left out of its file.",
      },
    ]);
  });

  it("blocks a face that has none of the selected characters", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    const resolution = resolveOne(
      project,
      faceId,
      select([{ kind: "script", script: "Deva" }])
    );
    expect(resolution.problems).toEqual([
      {
        code: "no-characters",
        faceId,
        message:
          "Specimen Regular has none of the selected characters. Select characters this face has, or leave it out of the export.",
      },
    ]);
  });

  it("warns about a selector that matches nothing and blocks an empty selection", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    const partly = resolveOne(
      project,
      faceId,
      select([
        { kind: "script", script: "Zzzz" },
        { codePoints: [0x41], kind: "characters" },
      ])
    );
    expect(partly.problems).toEqual([]);
    expect(partly.warnings.map((warning) => warning.message)).toEqual([
      "Nothing matched the script Zzzz. Check the selection.",
    ]);
    const nothing = resolveOne(
      project,
      faceId,
      select([{ block: "Nowhere", kind: "block" }])
    );
    expect(codes(nothing.problems)).toEqual(["no-characters"]);
    expect(nothing.problems[0]?.faceId).toBeUndefined();
  });

  it("ignores values that are not code points and reads a range in either order", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    const resolution = resolveOne(
      project,
      faceId,
      select([
        { codePoints: [-1, 0x11_00_00, 65.5, 0x41], kind: "characters" },
        { first: 0x44, kind: "range", last: 0x43 },
      ])
    );
    expect(derivedOf(resolution).request.subset?.characters).toEqual([
      0x41, 0x43, 0x44,
    ]);
    expect(resolution.warnings).toEqual([]);
  });

  it("counts characters the project added as part of the face", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    const withGlyph = withAnEdit(project, faceId);
    const added = {
      advance: 500,
      characters: [0x09_15],
      key: "ka",
      name: "ka-deva",
      outline: TRIANGLE,
      provenance: { origin: "manual" as const },
    };
    const extended = {
      ...withGlyph,
      head: withGlyph.head + 1,
      revisions: [
        ...withGlyph.revisions,
        {
          changes: [{ faceId, glyph: added, kind: "glyph-added" as const }],
          createdAt: "2026-11-10T09:00:00.000Z",
          id: "add-ka",
          label: "Add ka",
        },
      ],
    };
    const resolution = resolveOne(
      extended,
      faceId,
      select([{ kind: "language", language: "hi" }])
    );
    expect(derivedOf(resolution).request.subset?.characters).toEqual([0x09_15]);
    expect(derivedOf(resolution).request.added).toEqual([added]);
  });
});

describe("features", () => {
  it("passes a chosen set on and keeps every character", () => {
    const { faceId, project } = startProject(
      "Specimen.ttf",
      plain({
        layout: {
          positioning: ["kern"],
          scripts: ["latn"],
          substitution: ["liga"],
        },
      })
    );
    const resolution = resolveOne(project, faceId, {
      familyName: "Atlas Sans",
      features: chosen("liga", "kern", "liga"),
    });
    expect(resolution.warnings).toEqual([]);
    expect(derivedOf(resolution).request.subset).toEqual({
      characters: undefined,
      features: ["liga", "kern"],
    });
  });

  it("warns about a chosen feature the face does not have", () => {
    const { faceId, project } = startProject(
      "Specimen.ttf",
      plain({
        layout: { positioning: [], scripts: [], substitution: ["liga"] },
      })
    );
    const resolution = resolveOne(project, faceId, {
      familyName: "Atlas Sans",
      features: chosen("liga", "swsh"),
    });
    expect(resolution.warnings.map((warning) => warning.message)).toEqual([
      "Specimen Regular has no feature named swsh, so nothing is kept for it.",
    ]);
  });

  it("removes every feature for an empty chosen set", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    const resolution = resolveOne(project, faceId, {
      familyName: "Atlas Sans",
      features: chosen(),
    });
    expect(derivedOf(resolution).request.subset).toEqual({
      characters: undefined,
      features: [],
    });
  });
});

describe("variable sources", () => {
  it("keeps an untouched variable face variable, and exports the original when nothing else differs", () => {
    const { faceId, project } = startProject("Flex[wght].ttf", variable());
    expect(resolveOne(project, faceId).outputs[0]?.kind).toBe("original");
    const subset = derivedOf(
      resolveOne(project, faceId, {
        characters: {
          kind: "selected",
          selectors: [{ codePoints: [0x41], kind: "characters" }],
        },
        familyName: "Flex Web",
        format: "woff2",
      })
    );
    expect(subset.request.location).toBeUndefined();
    expect(subset.request.styleName).toBeUndefined();
    expect(subset.fileName).toBe("FlexWeb-Variable-subset.woff2");
  });

  it("pins a variable face where the plan says, and names the instance", () => {
    const { faceId, project } = startProject("Flex[wght].ttf", variable());
    const at = (location: Record<string, number>, styleName?: string) =>
      derivedOf(
        resolveExportPlan(
          project,
          planFor([], {
            faces: [
              { faceId, variable: { kind: "pinned", location, styleName } },
            ],
            familyName: "Flex Static",
          }),
          fakeLookups({})
        )
      );
    expect(at({ wght: 700 }).request).toMatchObject({
      location: { wght: 700 },
      styleName: "Bold",
    });
    expect(at({ wght: 700 }).fileName).toBe("FlexStatic-Bold.ttf");
    expect(at({ wght: 650 }).request.styleName).toBe("wght650");
    expect(at({ wght: 2000 }).request.location).toEqual({ wght: 900 });
    expect(at({}).request).toMatchObject({
      location: { wght: 400 },
      styleName: "Regular",
    });
    expect(at({ wght: 650 }, "Demi").fileName).toBe("FlexStatic-Demi.ttf");
  });

  it("exports a pinned instance at its own location", () => {
    const { faceId, project } = startProject("Flex[wght].ttf", variable());
    const pinned = pinInstance(project, faceId, { wght: 300 }, "Light");
    const edited = withAnEdit(pinned.project, pinned.face.id);
    const output = derivedOf(
      resolveOne(edited, pinned.face.id, { familyName: "Flex Static" })
    );
    expect(output.request).toMatchObject({
      location: { wght: 300 },
      overrides: new Map([[1, { advance: 640 }]]),
      styleName: "Light",
    });
    expect(output.fileName).toBe("FlexStatic-Light.ttf");
  });

  it("lets a pinned instance stay variable only while it has no changes", () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const { faceId, project } = startProject(
      "Flex[wght].ttf",
      variable(),
      bytes
    );
    const pinned = pinInstance(project, faceId, { wght: 300 }, "Light");
    const keep = planFor([], {
      faces: [{ faceId: pinned.face.id, variable: KEEP_VARIABLE }],
    });
    const untouched = resolveExportPlan(pinned.project, keep, fakeLookups({}));
    expect(untouched.problems).toEqual([]);
    expect(untouched.outputs).toEqual([
      {
        bytes,
        faceId: pinned.face.id,
        fileName: "Flex[wght].ttf",
        kind: "original",
      },
    ]);
    const changed = resolveExportPlan(
      withAnEdit(pinned.project, pinned.face.id),
      { ...keep, familyName: "Flex Static" },
      fakeLookups({})
    );
    expect(changed.problems).toEqual([
      {
        code: "variable-has-changes",
        faceId: pinned.face.id,
        message:
          "Flex Light has changes, and a changed face cannot stay variable. Export it at its pinned location, or undo its changes.",
      },
    ]);
  });

  it("says so when the plan pins an already pinned instance somewhere else", () => {
    const { faceId, project } = startProject("Flex[wght].ttf", variable());
    const pinned = pinInstance(project, faceId, { wght: 300 }, "Light");
    const resolve = (wght: number) =>
      resolveExportPlan(
        pinned.project,
        planFor([], {
          faces: [
            {
              faceId: pinned.face.id,
              variable: { kind: "pinned", location: { wght } },
            },
          ],
          familyName: "Flex Static",
        }),
        fakeLookups({})
      );
    expect(codes(resolve(800).warnings)).toEqual(["pinned-location-ignored"]);
    expect(derivedOf(resolve(800)).request.location).toEqual({ wght: 300 });
    expect(resolve(300).warnings).toEqual([]);
  });
});

describe("file names and the plan as a whole", () => {
  it("keeps the PostScript extension until a glyph is redrawn", () => {
    const { faceId, project } = startProject(
      "Mono.otf",
      plain({ familyName: "Mono", outlineFormat: "cff" })
    );
    const renamed = resolveOne(project, faceId, { familyName: "Mono Web" });
    expect(derivedOf(renamed).fileName).toBe("MonoWeb-Regular.otf");
    expect(renamed.warnings).toEqual([]);
    const edited = withAnEdit(project, faceId);
    const redrawn = resolveOne(edited, faceId, { familyName: "Mono Web" });
    expect(derivedOf(redrawn).fileName).toBe("MonoWeb-Regular.ttf");
    expect(codes(redrawn.warnings)).toEqual(["outlines-converted"]);
    expect(
      derivedOf(
        resolveOne(edited, faceId, { familyName: "Mono Web", format: "woff2" })
      ).fileName
    ).toBe("MonoWeb-Regular.woff2");
  });

  it("gives every output its own file name", () => {
    const first = startProject("One.ttf", plain());
    const second = importFace(first.project, "Two.ttf", plain());
    const third = importFace(
      second.project,
      "Three.ttf",
      plain({ styleName: "Bold Italic" })
    );
    const resolution = resolveExportPlan(
      third.project,
      planFor([first.faceId, second.faceId, third.faceId], {
        familyName: "Père & Fils",
      }),
      fakeLookups({})
    );
    expect(
      resolution.outputs.map((output: ExportOutput) => output.fileName)
    ).toEqual([
      "PèreFils-Regular.ttf",
      "PèreFils-Regular-2.ttf",
      "PèreFils-BoldItalic.ttf",
    ]);
  });

  it("resolves a face once, however often the plan lists it", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    expect(
      resolveExportPlan(project, planFor([faceId, faceId]), fakeLookups({}))
        .outputs
    ).toHaveLength(1);
  });

  it("blocks a plan with no faces, an unknown face or an empty family name", () => {
    const { faceId, project } = startProject("Specimen.ttf", plain());
    expect(
      resolveExportPlan(project, planFor([]), fakeLookups({})).problems
    ).toEqual([
      {
        code: "no-faces",
        message: "The plan has no faces. Choose at least one face to export.",
      },
    ]);
    const unknown = resolveExportPlan(
      project,
      planFor([faceId, "gone:0"]),
      fakeLookups({})
    );
    expect(codes(unknown.problems)).toEqual(["unknown-face"]);
    expect(unknown.outputs).toHaveLength(1);
    expect(
      codes(resolveOne(project, faceId, { familyName: "  " }).problems)
    ).toEqual(["empty-family-name"]);
  });

  it("writes every message as a plain sentence", () => {
    const { faceId, project } = startProject(
      "Lato.otf",
      plain({
        familyName: "Lato",
        licence: { ...RESERVING, embedding: 0x01_02 },
        outlineFormat: "cff",
      })
    );
    const resolution = resolveExportPlan(
      withAnEdit(project, faceId),
      planFor([faceId, "gone:0"], {
        characters: {
          kind: "selected",
          selectors: [
            { kind: "script", script: "Zzzz" },
            { first: 0x41, kind: "range", last: 0x1_00 },
          ],
        },
        features: chosen("swsh"),
      }),
      fakeLookups({ [faceId]: LATIN })
    );
    const messages = [...resolution.problems, ...resolution.warnings].map(
      (finding) => finding.message
    );
    expect(messages.length).toBeGreaterThanOrEqual(7);
    expectPlainSentences(messages);
  });
});
