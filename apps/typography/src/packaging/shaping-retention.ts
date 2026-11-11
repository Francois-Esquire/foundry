/**
 * Compares how a derived font shapes text with how its source does. Glyph ids
 * change when a font is subset, so the comparison is on what survives: how
 * many glyphs the text becomes and which characters each glyph stands for.
 */

import { count } from "~/lib/count";
import type { OpenFace, ShapedRun, ShapeOptions } from "~/typeface/reading";
import type { BuildRequest } from "./building";

export interface ShapingSample {
  /**
   * Set when the project's own feature code changes how this text shapes: the
   * number of glyphs it should now become. Without it, the text has to shape
   * the way it does in the source font.
   */
  readonly glyphCount?: number;
  readonly options?: ShapeOptions;
  readonly text: string;
}

export interface SampleResult {
  readonly detail: string;
  /** True when the source joins characters of this text into fewer glyphs. */
  readonly joins: boolean;
  readonly verdict: "same" | "different" | "not-checked";
}

const clustersOf = (run: ShapedRun) => run.glyphs.map((glyph) => glyph.cluster);

/**
 * A ligature or conjunct leaves fewer glyphs than characters. Clusters cannot
 * tell: a mark shares its base's cluster without any glyph being joined.
 */
const joinsCharacters = (run: ShapedRun, text: string) =>
  run.glyphs.length < [...text].length;

const sameClusters = (a: ShapedRun, b: ShapedRun) => {
  const [left, right] = [clustersOf(a), clustersOf(b)];
  return (
    left.length === right.length &&
    left.every((cluster, index) => cluster === right[index])
  );
};

/** Features the source has and the derived font was built without. */
const droppedFeatures = (source: OpenFace, request: BuildRequest) => {
  const kept = request.subset?.features;
  if (!kept) {
    return {};
  }
  const { positioning, substitution } = source.description.layout;
  return Object.fromEntries(
    [...positioning, ...substitution]
      .filter((tag) => !kept.includes(tag))
      .map((tag) => [tag, false])
  );
};

export interface FairOptions {
  /** What the derived font is asked. */
  readonly derived: ShapeOptions;
  /** What the source font is asked. */
  readonly source: ShapeOptions;
}

/**
 * The same question for a source font and the font derived from it, so the
 * answers can be compared: the source is shaped at the same instance and
 * without the features the derived font was built without.
 */
export const fairOptions = (
  source: OpenFace,
  request: BuildRequest,
  sample: ShapingSample
): FairOptions => ({
  derived: { ...sample.options },
  source: {
    ...sample.options,
    features: {
      ...droppedFeatures(source, request),
      ...sample.options?.features,
    },
    location: request.location ?? sample.options?.location,
  },
});

/** The characters of a text that every one of the faces holds. */
export const keptPart = (text: string, faces: readonly OpenFace[]) =>
  [...text]
    .filter((character) =>
      faces.every(
        (face) =>
          face.glyphForCharacter(character.codePointAt(0) ?? 0) !== undefined
      )
    )
    .join("");

const checkDeclared = (
  derived: OpenFace,
  sample: ShapingSample,
  expected: number
): SampleResult => {
  const text = keptPart(sample.text, [derived]);
  const run = derived.shape(text, sample.options);
  const same = text === sample.text && run.glyphs.length === expected;
  return {
    detail: same
      ? `"${sample.text}" becomes ${count(expected, "glyph")}, as the project's features intend.`
      : `"${sample.text}" becomes ${count(run.glyphs.length, "glyph")} where the project's features should give ${expected}.`,
    joins: false,
    verdict: same ? "same" : "different",
  };
};

/** Shapes one sample in both fonts, on the characters the derived font kept. */
export const checkSample = (
  source: OpenFace,
  derived: OpenFace,
  request: BuildRequest,
  sample: ShapingSample
): SampleResult => {
  if (sample.glyphCount !== undefined) {
    return checkDeclared(derived, sample, sample.glyphCount);
  }
  const text = keptPart(sample.text, [source, derived]);
  // Spaces alone compare nothing. A source with no letters of the text, such
  // as the empty font of a reconstruction, would otherwise pass on them.
  if (text.trim().length === 0) {
    const inDerived = keptPart(sample.text, [derived]).trim().length > 0;
    return {
      detail: inDerived
        ? `"${sample.text}" was not checked, because the source font draws none of its characters, so there is nothing to compare with.`
        : `"${sample.text}" was not checked, because the derived font keeps none of its characters.`,
      joins: false,
      verdict: "not-checked",
    };
  }
  const asBuilt = fairOptions(source, request, sample).source;
  const before = source.shape(text, asBuilt);
  const after = derived.shape(text, sample.options);
  const shown =
    text === sample.text
      ? `"${text}"`
      : `"${text}" (the kept part of "${sample.text}")`;
  const joins = joinsCharacters(before, text);
  if (!sameClusters(before, after)) {
    return {
      detail:
        before.glyphs.length === after.glyphs.length
          ? `${shown} groups its characters into glyphs differently from the source.`
          : `${shown} becomes ${count(after.glyphs.length, "glyph")} in the derived font and ${count(before.glyphs.length, "glyph")} in the source.`,
      joins,
      verdict: "different",
    };
  }
  const size = `${count(after.glyphs.length, "glyph")} from ${count([...text].length, "character")}`;
  const lost =
    !joins &&
    joinsCharacters(
      source.shape(text, { ...asBuilt, features: sample.options?.features }),
      text
    );
  return {
    detail: lost
      ? `${shown} becomes ${size}. The source joins these characters, but the feature that does it was not kept.`
      : `${shown} becomes ${size}, as in the source.`,
    joins,
    verdict: "same",
  };
};
