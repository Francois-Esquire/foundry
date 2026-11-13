import { describe, expect, it } from "vitest";
import { checkRows } from "~/generate/script-extension/check-rows";
import { DEVANAGARI_SUBSET } from "~/generation/script-extension/devanagari-subset";
import { extendScript } from "~/generation/script-extension/extend";
import { describeVerification } from "~/generation/script-extension/verification-report";
import { verifyExtension } from "~/generation/script-extension/verify";
import { decorateFace, type ShapedGlyph } from "~/typeface/reading";
import { fixtureFace } from "../../helpers/faces";
import { fixedRun } from "../../helpers/fixed";
import { loadSubsetRuns, rectangle, sheetsOf } from "./helpers/subset";

const shaped = (glyphId: number): ShapedGlyph => ({
  cluster: 0,
  glyphId,
  xAdvance: 100,
  xOffset: 0,
  yAdvance: 0,
  yOffset: 0,
});

const probe = async (ids: readonly number[], latinOffset?: number) => {
  const source = fixtureFace("lato");
  const first = source.description.glyphCount;
  const extension = await extendScript({
    ...fixedRun,
    face: source,
    faceId: "face",
    plan: DEVANAGARI_SUBSET,
    sheets: sheetsOf(loadSubsetRuns()),
  });
  const base = DEVANAGARI_SUBSET.glyphs.find(
    (planned) => planned.name === "sa-deva"
  );
  if (!base) {
    throw new Error("Missing base.");
  }
  const glyph = {
    advance: 100,
    anchors: { above: { x: 100, y: extension.lines.headlineTop } },
    key: base.name,
    madeBy: "Test outline.",
    outline: { contours: [rectangle(0, 0, 100, extension.lines.headlineTop)] },
    planned: base,
    provenance: { origin: "manual" as const },
  };
  const marks = DEVANAGARI_SUBSET.glyphs.filter((planned) =>
    ["anusvara-deva", "virama-deva"].includes(planned.name)
  );
  const plan = {
    ...DEVANAGARI_SUBSET,
    glyphs: [
      base,
      { ...base, name: "missing", text: "missing base" },
      ...marks.map((mark, index) => ({
        ...mark,
        shownIn: {
          base: index === 0 ? base.name : "missing",
          syllable: base.text + mark.text,
        },
      })),
    ],
    words: [{ glyphs: [base.name], text: "word" }],
  };
  const made = { ...extension, glyphs: [glyph], plan };
  const original = decorateFace(source, { close: () => undefined });
  const derived = decorateFace(source, {
    close: () => undefined,
    glyph: () => ({ advance: 100, outline: glyph.outline }),
    shape: (text) =>
      text === "latin"
        ? {
            ...source.shape(text),
            glyphs: source.shape(text).glyphs.map((placed) => ({
              ...placed,
              xOffset: placed.xOffset + (latinOffset ?? 0),
            })),
          }
        : {
            direction: "ltr",
            glyphs:
              text === "word"
                ? ids.map((id) => shaped(id < 0 ? first : id))
                : [
                    shaped(first),
                    {
                      ...shaped(first + 1),
                      xAdvance: 0,
                      yOffset: extension.lines.headlineTop,
                    },
                  ],
          },
  });
  const result = await verifyExtension({
    builder: {
      build: async () => ({ bytes: new Uint8Array([1]), notes: [] }),
      validate: async () => ({ issues: [], loadable: true }),
    },
    extension: made,
    familyName: "Probe",
    latinTexts: latinOffset === undefined ? [] : ["latin"],
    reader: {
      faceCount: () => 1,
      open: (bytes) => (bytes[0] === 1 ? derived : original),
    },
    source: { bytes: new Uint8Array([0]), faceIndex: 0 },
    working: {
      added: [glyph, { ...glyph, name: "anusvara-deva" }].map((entry) => ({
        ...entry,
        characters: [],
        name: "name" in entry ? entry.name : base.name,
      })),
      characters: new Map(),
      featureCode: [],
      overrides: new Map(),
    },
  });
  return { ...result, made };
};

describe("planned probes", () => {
  it.each([{ ids: [0] }, { ids: [1] }, { ids: [-1] }])(
    "does not claim a join for $ids",
    async ({ ids }) => {
      const { report, made } = await probe(ids);
      expect(report.headlines[0]).toMatchObject({ outcome: "not-run" });
      expect(
        checkRows(report).find((row) => row.id === "headlines")
      ).toMatchObject({ counted: "0 of 1", outcome: "not-run" });
      expect(describeVerification(made, report)).not.toContain(
        "Every check below passed."
      );
      expect(describeVerification(made, report)).toContain("did not run");
    }
  );
  it("fails Latin when only an offset changes", async () => {
    const { report } = await probe([-1], 1);
    expect(report.latin[0]?.pass).toBe(false);
  });
  it("keeps an unavailable mark beside the mark that ran", async () => {
    const { report } = await probe([-1]);
    expect(report.marks).toHaveLength(2);
    expect(report.marks[0]).toMatchObject({ outcome: "pass" });
    expect(report.marks[1]).toMatchObject({
      detail:
        "The base missing was not made, or has no place for a mark to attach.",
      outcome: "not-run",
    });
    expect(checkRows(report).find((row) => row.id === "marks")).toMatchObject({
      counted: "1 of 2",
      outcome: "not-run",
    });
  });
});
