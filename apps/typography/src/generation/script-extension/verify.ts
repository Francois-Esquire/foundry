/**
 * Verifies a script extension in a built font: the derived font is built and
 * opened through ports, and what the plan promises is checked in it. The
 * report says exactly what was checked, so the scope of the claim is the
 * scope of the test.
 */
import type { AddedGlyph, WorkingFace } from "~/typeface/changes";
import { type Outline, outlineBounds } from "~/typeface/outline";
import type { FontReader, OpenFace, ShapedGlyph } from "~/typeface/reading";
import type { MadeExtension } from "./extend";
import { readOnLines } from "./glyph-lines";
import { checkLetterIdentity, type LetterIdentity } from "./letter-identity";
import type { PlannedGlyph } from "./plan";

/**
 * What verification needs from a font engine. The building port in
 * `src/packaging` satisfies it; generation does not import packaging.
 */
interface DerivedFontBuilder {
  build(request: {
    readonly added: readonly AddedGlyph[];
    readonly faceIndex: number;
    readonly familyName: string;
    readonly featureCode: readonly string[];
    readonly overrides: WorkingFace["overrides"];
    readonly source: Uint8Array;
  }): Promise<{
    readonly bytes: Uint8Array;
    readonly notes: readonly string[];
  }>;
  validate(font: Uint8Array): Promise<{
    readonly issues: readonly {
      readonly message: string;
      readonly severity: "error" | "warning";
    }[];
    readonly loadable: boolean;
  }>;
}

export interface VerificationRequest {
  readonly builder: DerivedFontBuilder;
  readonly extension: MadeExtension;
  /** The derived font's family name, so it never passes for the source. */
  readonly familyName: string;
  /** Latin texts that must shape in the derived font as they do in the source. */
  readonly latinTexts?: readonly string[];
  readonly reader: FontReader;
  /** A face of the same script, for telling letters apart. Not a style reference. */
  readonly reference?: { readonly face: OpenFace; readonly name: string };
  readonly source: { readonly bytes: Uint8Array; readonly faceIndex: number };
  /** The face's applied changes, with the extension's among them. */
  readonly working: WorkingFace;
}

/** One text shaped in the derived font, against the glyphs it should give. */
export interface ShapingCheck {
  readonly expected: readonly string[];
  readonly got: readonly string[];
  readonly pass: boolean;
  readonly text: string;
}

interface CharacterCheck {
  readonly character: number;
  readonly expected: string;
  readonly got?: string;
  readonly pass: boolean;
}

/**
 * What a probe came to. A probe that had nothing to inspect did not run, and
 * that is never a pass.
 */
export type CheckOutcome = "fail" | "not-run" | "pass";

interface MarkCheck {
  readonly base: string;
  /** What was found, or why nothing was inspected, in words. */
  readonly detail: string;
  readonly mark: string;
  readonly outcome: CheckOutcome;
  readonly text: string;
}

interface HeadlineCheck {
  /** Where two neighbouring headlines do not meet, or why none was read, in words. */
  readonly detail: string;
  readonly outcome: CheckOutcome;
  readonly text: string;
}

export interface VerificationReport {
  readonly characters: readonly CharacterCheck[];
  readonly familyName: string;
  /** Unmapped forms, each reached through the text that needs it. */
  readonly forms: readonly ShapingCheck[];
  readonly headlines: readonly HeadlineCheck[];
  /** Absent when no reference face was given. */
  readonly identity?: {
    readonly letters: readonly LetterIdentity[];
    readonly reference: string;
  };
  readonly latin: readonly ShapingCheck[];
  readonly marks: readonly MarkCheck[];
  /**
   * True when every check that ran passed. A probe that did not run is not a
   * pass, and does not fail the report by itself.
   */
  readonly pass: boolean;
  /** The reader's script tags for the derived font. */
  readonly scripts: readonly string[];
  readonly validation: {
    readonly errors: readonly string[];
    readonly loadable: boolean;
    readonly notes: readonly string[];
    readonly warnings: readonly string[];
  };
  readonly words: readonly ShapingCheck[];
}

export interface Verification {
  readonly derived: OpenFace;
  readonly font: Uint8Array;
  readonly report: VerificationReport;
}

const DEFAULT_LATIN = ["fi", "office", "AVATAR", "Typography"];

const sameSequence = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, index) => name === b[index]);

/** The text and glyphs that show each unmapped form is reached. */
const formProbes = (
  glyphs: readonly PlannedGlyph[]
): { expected: string[]; text: string }[] =>
  glyphs.flatMap((glyph) => {
    if (glyph.rule.kind === "conjunct") {
      return [{ expected: [glyph.name], text: glyph.text }];
    }
    if (glyph.rule.kind === "half-form" && glyph.shownIn) {
      return [
        {
          expected: [glyph.name, glyph.shownIn.base],
          text: glyph.shownIn.syllable,
        },
      ];
    }
    return [];
  });

interface Placed {
  readonly name: string;
  readonly outline: Outline;
  readonly shaped: ShapedGlyph;
  /** Where the glyph's origin sits on the line. */
  readonly x: number;
}

export const verifyExtension = async (
  request: VerificationRequest
): Promise<Verification> => {
  const { builder, extension, reader, source, working } = request;
  const { lines, plan } = extension;
  const built = await builder.build({
    added: working.added,
    faceIndex: source.faceIndex,
    familyName: request.familyName,
    featureCode: working.featureCode,
    overrides: working.overrides,
    source: source.bytes,
  });
  const validation = await builder.validate(built.bytes);
  const original = reader.open(source.bytes, source.faceIndex);
  const derived = reader.open(built.bytes, source.faceIndex);
  const options = { script: plan.iso15924 };
  // The engine appends added glyphs in order, after the source font's own.
  const firstAdded = original.description.glyphCount;
  const nameOf = (glyphId: number) =>
    working.added[glyphId - firstAdded]?.name ?? `source:${glyphId}`;
  const idOf = (name: string) => {
    const index = working.added.findIndex((glyph) => glyph.name === name);
    return index < 0 ? undefined : firstAdded + index;
  };
  const place = (text: string): Placed[] => {
    let pen = 0;
    return derived.shape(text, options).glyphs.map((shaped) => {
      const placed = {
        name: nameOf(shaped.glyphId),
        outline: derived.glyph(shaped.glyphId).outline,
        shaped,
        x: pen + shaped.xOffset,
      };
      pen += shaped.xAdvance;
      return placed;
    });
  };
  const shapes = (text: string, expected: readonly string[]): ShapingCheck => {
    const got = place(text).map((glyph) => glyph.name);
    return { expected, got, pass: sameSequence(expected, got), text };
  };
  const planned = (name: string) =>
    extension.glyphs.find((glyph) => glyph.planned.name === name);

  const characters = plan.glyphs.flatMap((glyph) =>
    glyph.characters.map((character): CharacterCheck => {
      const glyphId = derived.glyphForCharacter(character);
      const got = glyphId === undefined ? undefined : nameOf(glyphId);
      return { character, expected: glyph.name, got, pass: got === glyph.name };
    })
  );

  const markCheck = (glyph: PlannedGlyph): MarkCheck[] => {
    const shown = glyph.shownIn;
    // A mark the plan shows on no base has no pair to probe.
    if (!shown) {
      return [];
    }
    const base = plan.glyphs.find((other) => other.name === shown.base);
    const anchors = base && planned(base.name)?.anchors;
    if (!(base && anchors)) {
      return [
        {
          base: shown.base,
          detail: `The base ${shown.base} was not made, or has no place for a mark to attach.`,
          mark: glyph.name,
          outcome: "not-run",
          text: shown.syllable,
        },
      ];
    }
    const above = glyph.rule.kind === "mark-above";
    const text = `${base.text}${glyph.text}`;
    const [carrier, sign] = place(text);
    const bounds = sign && outlineBounds(sign.outline);
    const point = above ? anchors.above : anchors.below;
    const result = (pass: boolean, detail: string): MarkCheck[] => [
      {
        base: base.name,
        detail,
        mark: glyph.name,
        outcome: pass ? "pass" : "fail",
        text,
      },
    ];
    if (
      !(carrier && sign && bounds && point) ||
      carrier.name !== base.name ||
      sign.name !== glyph.name
    ) {
      return result(false, "The text did not shape to the base and the mark.");
    }
    const clear = above
      ? bounds.yMin + sign.shaped.yOffset >= lines.bodyTop
      : bounds.yMax + sign.shaped.yOffset <= 0;
    const onStem = sign.x === carrier.x + point.x;
    const attached = sign.shaped.xAdvance === 0 && onStem && clear;
    return result(
      attached,
      `Advance ${sign.shaped.xAdvance}. Its attaching point is at ${sign.x}, the base's stem at ${carrier.x + point.x}. Its ink runs from ${Math.round(bounds.yMin + sign.shaped.yOffset)} to ${Math.round(bounds.yMax + sign.shaped.yOffset)}, ${above ? `with the headline's underside at ${lines.bodyTop}` : "with the baseline at 0"}.`
    );
  };

  const headlineCheck = (text: string): HeadlineCheck => {
    const letters = place(text).filter((glyph) => {
      const kind = planned(glyph.name)?.planned.rule.kind;
      return (
        kind !== undefined && kind !== "mark-above" && kind !== "mark-below"
      );
    });
    const gaps: string[] = [];
    let pairs = 0;
    letters.forEach((glyph, index) => {
      const read = readOnLines(glyph.outline, lines);
      const before = letters[index - 1];
      const previous = before && readOnLines(before.outline, lines);
      if (!read) {
        gaps.push(`${glyph.name} has no headline on the lines.`);
        return;
      }
      // A letter whose headline covers only its right part starts with open paper.
      const open = (read.bodyLeft ?? read.headline.left) < read.headline.left;
      if (before && previous && !open) {
        pairs += 1;
        const gap =
          glyph.x + read.headline.left - (before.x + previous.headline.right);
        if (gap > 1) {
          gaps.push(
            `${Math.round(gap)} units of paper between the headlines of ${before.name} and ${glyph.name}.`
          );
        }
      }
    });
    if (gaps.length > 0) {
      return { detail: gaps.join(" "), outcome: "fail", text };
    }
    // With no pair read there is no join to speak of, so nothing passed.
    if (pairs === 0) {
      return {
        detail: "There is no pair of neighbouring headlines to read.",
        outcome: "not-run",
        text,
      };
    }
    return {
      detail: "The headlines of neighbouring letters meet.",
      outcome: "pass",
      text,
    };
  };

  const generated = new Map<string, Outline>(
    plan.glyphs.flatMap((glyph): [string, Outline][] => {
      const glyphId = idOf(glyph.name);
      return glyphId === undefined
        ? []
        : [[glyph.name, derived.glyph(glyphId).outline]];
    })
  );
  const identity = request.reference && {
    letters: checkLetterIdentity(
      plan,
      lines,
      generated,
      request.reference.face,
      derived.description.metrics.unitsPerEm
    ),
    reference: request.reference.name,
  };

  const latin = (request.latinTexts ?? DEFAULT_LATIN).map(
    (text): ShapingCheck => {
      const describe = (face: OpenFace) =>
        face
          .shape(text)
          .glyphs.map((glyph) =>
            [
              glyph.glyphId,
              glyph.cluster,
              glyph.xAdvance,
              glyph.yAdvance,
              glyph.xOffset,
              glyph.yOffset,
            ].join("+")
          );
      const expected = describe(original);
      const got = describe(derived);
      return { expected, got, pass: sameSequence(expected, got), text };
    }
  );
  original.close();

  const words = plan.words.map((word) => shapes(word.text, word.glyphs));
  const forms = formProbes(plan.glyphs).map((probe) =>
    shapes(probe.text, probe.expected)
  );
  const marks = plan.glyphs
    .filter(
      (glyph) =>
        glyph.rule.kind === "mark-above" || glyph.rule.kind === "mark-below"
    )
    .flatMap(markCheck);
  const headlines = plan.words.map((word) => headlineCheck(word.text));
  const errors = validation.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.message);
  const checks: readonly { readonly pass: boolean }[] = [
    ...characters,
    ...forms,
    ...words,
    ...latin,
    ...(identity?.letters ?? []),
  ];
  const probes = [...marks, ...headlines];
  return {
    derived,
    font: built.bytes,
    report: {
      characters,
      familyName: request.familyName,
      forms,
      headlines,
      identity,
      latin,
      marks,
      pass:
        validation.loadable &&
        errors.length === 0 &&
        extension.missing.length === 0 &&
        checks.every((check) => check.pass) &&
        probes.every((probe) => probe.outcome !== "fail"),
      scripts: derived.description.layout.scripts,
      validation: {
        errors,
        loadable: validation.loadable,
        notes: built.notes,
        warnings: validation.issues
          .filter((issue) => issue.severity === "warning")
          .map((issue) => issue.message),
      },
      words,
    },
  };
};
