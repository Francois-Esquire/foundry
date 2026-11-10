/**
 * The height model for a script whose letters hang from a headline, such as
 * Devanagari. Latin has no headline, so the lines are derived from what the
 * source face does have: its x-height and the thickness of its level strokes.
 */
import type { HeightModel, HeightZone } from "../normalise/height-model";
import type { GlyphTarget } from "../plan/target";
import type { StyleReference } from "../style/reference";
import {
  type FormRuleKind,
  type PlannedGlyph,
  type ScriptExtensionPlan,
  syllableKey,
} from "./plan";

/** Heights above the baseline, which is 0, in font units. */
export interface HeadlineLines {
  /** The underside of the headline: the top of the space the letters' bodies fill. */
  readonly bodyTop: number;
  readonly headlineThickness: number;
  readonly headlineTop: number;
  /** The rule the lines came from, in words. */
  readonly rule: string;
}

/**
 * The rule: the body of a letter, from the baseline to the underside of the
 * headline, is as tall as the face's lowercase, and the headline lies on top
 * of that, as thick as the face's level strokes. The eye sizes these letters
 * by the space under the headline, the way it sizes Latin by the x-height, so
 * the two scripts then look the same size in a line; and a headline as thick
 * as the crossbar of an H keeps the weight. The headline never goes above the
 * capitals.
 */
export const headlineLines = (style: StyleReference): HeadlineLines => {
  const { capHeight, xHeight } = style.metrics;
  const thickness = Math.round(style.stems.horizontal);
  const headlineTop = Math.round(Math.min(capHeight, xHeight + thickness));
  return {
    bodyTop: headlineTop - thickness,
    headlineThickness: thickness,
    headlineTop,
    rule: `The body under the headline is as tall as the lowercase (x-height ${Math.round(xHeight)}), and the headline on top of it is as thick as the face's level strokes (${thickness}), so its top edge is at ${headlineTop}. Capitals are ${Math.round(capHeight)} tall.`,
  };
};

type Reach = "free" | "line";

/** Whether a glyph of each rule reaches the headline's top edge and the baseline. */
const REACH: Readonly<
  Record<FormRuleKind, { readonly bottom: Reach; readonly top: Reach }>
> = {
  base: { bottom: "line", top: "line" },
  // A conjunct often carries a tail below the baseline.
  conjunct: { bottom: "free", top: "line" },
  // A half form hangs from the headline and need not reach the baseline.
  "half-form": { bottom: "free", top: "line" },
  "mark-above": { bottom: "free", top: "free" },
  "mark-below": { bottom: "free", top: "free" },
  // A vowel sign's stem stands on the baseline; a hook may rise over the headline.
  "vowel-sign-after": { bottom: "line", top: "free" },
  "vowel-sign-before": { bottom: "line", top: "free" },
};

const zoneFor = (
  name: string,
  reach: { readonly bottom: Reach; readonly top: Reach },
  lines: HeadlineLines
): HeightZone => ({
  bottom: reach.bottom === "line" ? 0 : undefined,
  name,
  top: reach.top === "line" ? lines.headlineTop : undefined,
});

/** Parts that can put ink over the headline of the syllable they are shown in. */
const OVER_HEADLINE: ReadonlySet<FormRuleKind> = new Set([
  "mark-above",
  "vowel-sign-after",
  "vowel-sign-before",
]);

/**
 * A syllable is fitted by the lines its parts leave alone: a mark above or a
 * vowel sign, which may carry a hook, frees the top, and a mark below frees
 * the bottom.
 */
const syllableReach = (parts: readonly PlannedGlyph[]) => ({
  bottom: parts.some((part) => part.rule.kind === "mark-below")
    ? ("free" as const)
    : ("line" as const),
  top: parts.some((part) => OVER_HEADLINE.has(part.rule.kind))
    ? ("free" as const)
    : ("line" as const),
});

/** The pipeline's height model for a plan: which lines each target stands between. */
export const headlineHeightModel = (
  plan: ScriptExtensionPlan,
  lines: HeadlineLines
): HeightModel => {
  const zones = new Map<string, HeightZone>();
  for (const glyph of plan.glyphs) {
    zones.set(
      glyph.name,
      zoneFor(glyph.rule.kind.replace("-", " "), REACH[glyph.rule.kind], lines)
    );
    const syllable = glyph.shownIn?.syllable;
    if (syllable !== undefined) {
      const parts = plan.glyphs.filter(
        (other) => other.shownIn?.syllable === syllable
      );
      zones.set(
        syllableKey(syllable),
        zoneFor("syllable", syllableReach(parts), lines)
      );
    }
  }
  return (target: GlyphTarget) =>
    zones.get(target.key) ?? { name: "unplanned" };
};
