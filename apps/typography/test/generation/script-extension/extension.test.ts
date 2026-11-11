/**
 * Script-aware generation on real model output. A recorded run holds two
 * sheets a vector model drew for Lato: letters, and syllables on a known
 * base. This extends Lato with the Devanagari subset from them, builds the
 * derived font and checks what the plan promises in it.
 *
 * Nothing here calls a model, and every glyph says in its provenance that it
 * was replayed from a recording.
 */

import { sha256Hex } from "@foundry/lib/digest";
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { DEVANAGARI_SUBSET as plan } from "~/generation/script-extension/devanagari-subset";
import {
  extendScript,
  type ScriptExtension,
} from "~/generation/script-extension/extend";
import { readOnLines } from "~/generation/script-extension/glyph-lines";
import { ExtensionPlanError } from "~/generation/script-extension/plan";
import { describeVerification } from "~/generation/script-extension/verification-report";
import {
  type Verification,
  verifyExtension,
} from "~/generation/script-extension/verify";
import { nodeFontBuilder } from "~/packaging/engine/node";
import type { WorkingFace } from "~/typeface/changes";
import { outlineBounds } from "~/typeface/outline";
import {
  addSource,
  commit,
  emptyProject,
  undo,
  workingFaceOf,
} from "~/typeface/project";
import type { OpenFace } from "~/typeface/reading";
import { fixtureFace } from "../../helpers/faces";
import { fixedRun, stamp } from "../../helpers/fixed";
import { fontBytes } from "../../helpers/fixtures";
import { loadSubsetRuns, sheetsOf } from "./helpers/subset";

const ANUSVARA_CLASS = /markClass anusvara-deva <anchor 0 \d+> @Deva_above;/;
const GLYPH_CLASSES =
  /GlyphClassDef \[a-deva [^\]]*\], , \[eMatra-deva anusvara-deva virama-deva\], ;/;

/** Starting the font engine and building a font can outlast the default hook limit. */
const SETUP_TIMEOUT = 120_000;

describe("extending Lato with a generated Devanagari subset", () => {
  const lato = fontBytes("lato");
  const face = fixtureFace("lato");
  let extension: ScriptExtension;
  let working: WorkingFace;
  let verification: Verification;
  let derived: OpenFace;
  let faceId: string;

  const glyphNamed = (name: string) => {
    const glyph = extension.glyphs.find(
      (candidate) => candidate.planned.name === name
    );
    if (!glyph) {
      throw new Error(`${name} was not made.`);
    }
    return glyph;
  };
  const boundsNamed = (name: string) => {
    const bounds = outlineBounds(glyphNamed(name).outline);
    if (!bounds) {
      throw new Error(`${name} has no outline.`);
    }
    return bounds;
  };

  beforeAll(async () => {
    const imported = addSource(
      emptyProject(),
      {
        bytes: lato,
        fileName: "Lato-Regular.ttf",
        id: await sha256Hex(lato),
        importedAt: "2026-11-10T00:00:00.000Z",
      },
      [face.description]
    );
    faceId = imported.faces[0]?.id ?? "";
    extension = await extendScript({
      ...fixedRun,
      face,
      faceId,
      plan,
      sheets: sheetsOf(loadSubsetRuns()),
    });
    // The extension is one ordinary revision, and undoing it removes it.
    const project = commit(imported, {
      ...stamp(),
      changes: extension.changes,
      label: "Add a Devanagari subset",
    });
    expect(workingFaceOf(undo(project), faceId).added).toEqual([]);
    working = workingFaceOf(project, faceId);
    verification = await verifyExtension({
      builder: await nodeFontBuilder(),
      extension,
      familyName: "Devanagari Subset",
      reader: harfBuzzReader,
      reference: {
        face: fixtureFace("devanagari"),
        name: "Noto Sans Devanagari",
      },
      source: { bytes: lato, faceIndex: 0 },
      working,
    });
    ({ derived } = verification);
  }, SETUP_TIMEOUT);

  describe("reading the sheets", () => {
    it("fits both sheets by the script's own lines, not by Latin ones", () => {
      expect(extension.lines.headlineTop).toBe(
        Math.round(
          extension.style.metrics.xHeight + extension.style.stems.horizontal
        )
      );
      for (const run of extension.runs) {
        expect(run.artefacts.fit?.basis).toBe("height-model");
        expect(run.record.recorded).toBe(true);
      }
    });

    it("sets aside the six cells of the letters sheet the model drew wrong", () => {
      const [letters, syllables] = extension.runs;
      expect(letters?.artefacts.extraction?.report.extra).toHaveLength(6);
      expect(letters?.artefacts.extraction?.glyphs).toHaveLength(10);
      expect(syllables?.artefacts.extraction?.report.extra).toHaveLength(0);
      expect(syllables?.artefacts.extraction?.glyphs).toHaveLength(8);
    });

    it("makes every planned glyph, each marked as replayed from a recording", () => {
      expect(extension.missing).toEqual([]);
      expect(extension.glyphs.map((glyph) => glyph.planned.name)).toEqual(
        plan.glyphs.map((glyph) => glyph.name)
      );
      for (const glyph of extension.glyphs) {
        expect(glyph.provenance).toMatchObject({
          model: "ideogram/vector/text-to-vector",
          origin: "generated",
          recorded: true,
        });
      }
    });

    it("keeps the syllables themselves out of the face", () => {
      for (const run of extension.runs) {
        for (const candidate of run.candidates) {
          expect(candidate.name.startsWith("syllable:")).toBe(false);
        }
      }
    });
  });

  describe("separating marks from syllables", () => {
    it.each(plan.glyphs.filter((glyph) => glyph.shownIn))(
      "records that $name was separated from a generated syllable",
      (planned) => {
        const glyph = glyphNamed(planned.name);
        expect(glyph.madeBy).toContain(
          `Separated from the generated syllable ${planned.shownIn?.syllable}`
        );
        expect(glyph.evaluation?.weaknesses.join(" ")).toContain(
          "base it was drawn on"
        );
      }
    );

    it("takes the vowel sign after the base as a stem with its share of the headline", () => {
      const sign = boundsNamed("aaMatra-deva");
      expect(sign.xMin).toBe(0);
      expect(sign.yMax).toBe(extension.lines.headlineTop);
      expect(Math.abs(sign.yMin)).toBeLessThan(40);
      // A stem and the headline over it: far narrower than a letter.
      expect(sign.xMax).toBeLessThan(boundsNamed("ra-deva").xMax);
    });

    it("takes the hooked vowel signs with their hooks over the headline", () => {
      const before = boundsNamed("iMatra-deva");
      const after = boundsNamed("iiMatra-deva");
      const top = extension.lines.headlineTop;
      expect(before.yMax).toBeGreaterThan(top + 300);
      expect(after.yMax).toBeGreaterThan(top + 300);
      // The hook of the sign before the base reaches right, over the letter that follows.
      expect(before.xMax).toBeGreaterThan(
        glyphNamed("iMatra-deva").advance + 500
      );
      // The hook of the sign after the base reaches back, over the letter before.
      expect(after.xMin).toBeLessThan(-500);
    });

    it("takes the marks above from over the headline and the halant from under the baseline", () => {
      expect(boundsNamed("anusvara-deva").yMin).toBeGreaterThan(
        extension.lines.headlineTop
      );
      // The vowel sign stands on the headline, and keeps a tab down into it.
      const sign = boundsNamed("eMatra-deva");
      expect(sign.yMin).toBeLessThan(extension.lines.headlineTop);
      expect(sign.yMin).toBeGreaterThan(extension.lines.bodyTop);
      expect(boundsNamed("virama-deva").yMax).toBeLessThan(0);
    });

    it("takes the half forms from the left of their conjuncts, hanging from the headline", () => {
      for (const name of ["sa-deva.half", "na-deva.half"]) {
        const half = boundsNamed(name);
        expect(half.yMax).toBe(extension.lines.headlineTop);
        expect(half.xMin).toBe(0);
        // The joining stroke reaches past the advance, into the letter that follows.
        expect(half.xMax).toBeGreaterThan(glyphNamed(name).advance);
      }
      expect(boundsNamed("sa-deva.half").xMax).toBeLessThan(
        boundsNamed("sa-deva").xMax
      );
    });
  });

  describe("composing changes for the face", () => {
    it("adds eighteen glyphs with their character mappings and one set of rules", () => {
      expect(working.added).toHaveLength(18);
      expect(working.featureCode).toHaveLength(1);
      expect(
        working.added.find((glyph) => glyph.name === "ka-deva")?.characters
      ).toEqual([0x09_15]);
      expect(
        working.added.find((glyph) => glyph.name === "kssa-deva")?.characters
      ).toEqual([]);
    });

    it("writes the conjunct, the half forms, the mark classes and the glyph classes", () => {
      const [code] = working.featureCode;
      expect(code).toContain("languagesystem dev2 dflt;");
      expect(code).toContain("sub ka-deva virama-deva ssa-deva by kssa-deva;");
      expect(code).toContain("sub sa-deva virama-deva by sa-deva.half;");
      expect(code).toContain("sub na-deva virama-deva by na-deva.half;");
      expect(code).toMatch(ANUSVARA_CLASS);
      expect(code).toContain("markClass virama-deva <anchor 0 0> @Deva_below;");
      expect(code).toMatch(GLYPH_CLASSES);
    });

    it("puts every letter's headline on the same line and joins it to the next", () => {
      const top = extension.lines.headlineTop;
      for (const glyph of extension.glyphs) {
        const { kind } = glyph.planned.rule;
        if (kind === "mark-above" || kind === "mark-below") {
          expect(glyph.advance).toBe(0);
          continue;
        }
        const read = readOnLines(glyph.outline, extension.lines);
        expect(read, glyph.planned.name).toBeDefined();
        // The glyph's box ends inside its headline, so the next one overlaps it.
        expect(read?.headline.right).toBeGreaterThan(glyph.advance);
        if (kind === "base") {
          expect(
            Math.abs(boundsNamed(glyph.planned.name).yMax - top)
          ).toBeLessThan(25);
        }
      }
    });

    it("anchors marks on each letter's own main stem", () => {
      // क carries its stem in the middle, the others on the right.
      const ka = glyphNamed("ka-deva");
      const ta = glyphNamed("ta-deva");
      expect(ka.anchors.above?.x).toBeGreaterThan(0.4 * ka.advance);
      expect(ka.anchors.above?.x).toBeLessThan(0.65 * ka.advance);
      expect(ta.anchors.above?.x).toBeGreaterThan(0.7 * ta.advance);
      expect(ta.anchors.above?.y).toBe(extension.lines.headlineTop);
      expect(ta.anchors.below?.y).toBe(0);
    });

    it("keeps the left part of अ inside its box, where no headline covers it", () => {
      const a = boundsNamed("a-deva");
      const read = readOnLines(glyphNamed("a-deva").outline, extension.lines);
      expect(a.xMin).toBeGreaterThan(0);
      expect(read?.headline.left).toBeGreaterThan(a.xMin + 500);
    });

    it("refuses a plan whose glyph names the source font already uses", async () => {
      const taken = face.glyphName(40);
      const [first, ...rest] = plan.glyphs;
      if (!first) {
        throw new Error("The plan has no glyphs.");
      }
      await expect(
        extendScript({
          ...fixedRun,
          face,
          faceId,
          plan: { ...plan, glyphs: [{ ...first, name: taken }, ...rest] },
          sheets: [],
        })
      ).rejects.toThrow(ExtensionPlanError);
    });
  });

  describe("the derived font", () => {
    it("builds and passes the engine's validation", () => {
      expect(verification.report.validation.loadable).toBe(true);
      expect(verification.report.validation.errors).toEqual([]);
      expect(verification.report.scripts).toContain("dev2");
      expect(derived.description.familyName).toBe("Devanagari Subset");
    });

    it("maps all fifteen characters to their own glyphs", () => {
      expect(verification.report.characters).toHaveLength(15);
      expect(
        verification.report.characters.filter((check) => !check.pass)
      ).toEqual([]);
    });

    it.each(plan.words)("shapes $text to the planned glyphs", (word) => {
      const check = verification.report.words.find(
        (candidate) => candidate.text === word.text
      );
      expect(check?.got).toEqual(word.glyphs);
      expect(check?.pass).toBe(true);
    });

    it("reaches the conjunct and both half forms through layout rules", () => {
      expect(
        verification.report.forms.map((form) => [form.text, form.got])
      ).toEqual([
        ["क्ष", ["kssa-deva"]],
        ["स्त", ["sa-deva.half", "ta-deva"]],
        ["न्त", ["na-deva.half", "ta-deva"]],
      ]);
    });

    it("moves the short i vowel sign before its consonant", () => {
      const [first] = derived.shape("सि", { script: "Deva" }).glyphs;
      expect(first?.glyphId).toBe(derived.glyphForCharacter(0x09_3f));
    });

    it("hangs each mark on its base's stem with no advance", () => {
      expect(verification.report.marks.map((check) => check.mark)).toEqual([
        "eMatra-deva",
        "anusvara-deva",
        "virama-deva",
      ]);
      for (const check of verification.report.marks) {
        expect(check.pass, check.detail).toBe(true);
      }
      const [base, mark] = derived.shape("सं", { script: "Deva" }).glyphs;
      const stem = glyphNamed("sa-deva").anchors.above?.x ?? 0;
      expect(mark?.xAdvance).toBe(0);
      expect(mark?.xOffset).toBe(stem - (base?.xAdvance ?? 0));
    });

    it("joins the headlines of neighbouring letters in every test word", () => {
      for (const check of verification.report.headlines) {
        expect(check.gaps, check.text).toEqual([]);
      }
    });

    it("draws each letter more like its own reference letter than any other", () => {
      const letters = verification.report.identity?.letters ?? [];
      console.log(
        "letter identity against Noto Sans Devanagari",
        JSON.stringify(
          letters.map((letter) => [
            letter.name,
            Number(letter.ownScore.toFixed(2)),
          ])
        )
      );
      expect(letters).toHaveLength(10);
      expect(letters.filter((letter) => !letter.pass)).toEqual([]);
    });

    it("still shapes Lato's Latin in the same font", () => {
      for (const check of verification.report.latin) {
        expect(check.pass, check.text).toBe(true);
      }
      expect(derived.shape("fi").glyphs).toHaveLength(1);
      const firstAdded = face.description.glyphCount;
      expect(
        derived
          .shape("fi नाम")
          .glyphs.map((glyph) => glyph.glyphId >= firstAdded)
      ).toEqual([false, false, true, true, true]);
    });

    it("passes as a whole", () => {
      expect(verification.report.pass).toBe(true);
    });
  });

  describe("the verification report", () => {
    it("states the verified scope and what was not verified, in plain words", () => {
      const text = describeVerification(extension, verification.report);
      expect(text).toContain("It is not support for Devanagari.");
      expect(text).toContain(
        "replayed from a recorded run, no model was called"
      );
      for (const word of plan.words) {
        expect(text).toContain(`- ${word.text}: ${word.glyphs.join(" ")} (ok)`);
      }
      expect(text).toContain("## Not verified");
      expect(text).toContain("No test word uses these glyphs.");
      expect(text).toContain("virama-deva runs from");
      expect(text).not.toContain("FAILED");
    });

    it("says how far the new letters' weight is from the Latin", () => {
      const { weight } = extension;
      expect(weight.headline).toBeGreaterThan(0.75 * weight.levelStroke);
      expect(weight.headline).toBeLessThan(weight.levelStroke);
      expect(weight.stem).toBeGreaterThan(0.75 * weight.uprightStroke);
    });

    it("marks a failure where a word does not shape as planned", () => {
      const [first, ...rest] = verification.report.words;
      if (!first) {
        throw new Error("The report has no words.");
      }
      const text = describeVerification(extension, {
        ...verification.report,
        pass: false,
        words: [{ ...first, got: ["na-deva"], pass: false }, ...rest],
      });
      expect(text).toContain("Not every check passed.");
      expect(text).toContain(`- ${first.text}: FAILED. Planned`);
    });
  });
});
