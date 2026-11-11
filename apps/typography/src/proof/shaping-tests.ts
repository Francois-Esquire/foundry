/**
 * The table of shaping tests: for each sample text, how many glyphs it
 * becomes and how its characters group into glyphs, in the source and in the
 * derived font, and whether the two agree.
 */
import type { BuildRequest } from "~/packaging/building";
import {
  checkSample,
  fairOptions,
  keptPart,
  type ShapingSample,
} from "~/packaging/shaping-retention";
import type { OpenFace, ShapedRun } from "~/typeface/reading";

export interface ShapedSide {
  /** The cluster of each glyph, in the order the glyphs are set. */
  readonly clusters: readonly number[];
  readonly glyphCount: number;
}

export interface ShapingTest {
  /** Undefined when the two fonts share none of the sample's characters. */
  readonly derived: ShapedSide | undefined;
  /** One sentence on what was found, from the packaging check. */
  readonly detail: string;
  /** True when the source joins characters of the text into fewer glyphs. */
  readonly joins: boolean;
  readonly source: ShapedSide | undefined;
  /** The sample as written. */
  readonly text: string;
  readonly verdict: "pass" | "fail" | "not-checked";
}

const VERDICTS = {
  different: "fail",
  "not-checked": "not-checked",
  same: "pass",
} as const;

const sideOf = (run: ShapedRun): ShapedSide => ({
  clusters: run.glyphs.map((glyph) => glyph.cluster),
  glyphCount: run.glyphs.length,
});

export const shapingTest = (
  source: OpenFace,
  derived: OpenFace,
  request: BuildRequest,
  sample: ShapingSample
): ShapingTest => {
  const result = checkSample(source, derived, request, sample);
  // The same characters packaging compares: the ones both fonts hold.
  const text = keptPart(sample.text, [source, derived]);
  const options = fairOptions(source, request, sample);
  // Spaces alone are not a comparison, and packaging does not make one.
  const checked = result.verdict !== "not-checked" && text.trim().length > 0;
  return {
    derived: checked ? sideOf(derived.shape(text, options.derived)) : undefined,
    detail: result.detail,
    joins: result.joins,
    source: checked ? sideOf(source.shape(text, options.source)) : undefined,
    text: sample.text,
    verdict: VERDICTS[result.verdict],
  };
};
