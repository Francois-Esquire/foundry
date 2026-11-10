/**
 * Layout features as switches for a specimen. A shaper applies some features
 * by itself and leaves others off, so a switch only reaches the shaper when
 * it differs from that default.
 */
import type { LayoutFeatures } from "~/typeface/face";

/** Feature tag to on or off, holding only the features switched away from their default. */
export type FeatureChoices = Readonly<Record<string, boolean>>;

/**
 * Features HarfBuzz applies without being asked: the common ones for
 * horizontal text, and the ones its script shapers drive themselves.
 */
const ON_BY_DEFAULT = new Set([
  ...["abvm", "blwm", "calt", "ccmp", "clig", "curs", "dist", "kern", "liga"],
  ...["locl", "mark", "mkmk", "rclt", "rlig", "rvrn"],
  ...["fina", "fin2", "fin3", "init", "isol", "medi", "med2", "mset", "stch"],
  ...["abvf", "abvs", "akhn", "blwf", "blws", "cfar", "cjct", "half", "haln"],
  ...["nukt", "pref", "pres", "pstf", "psts", "rkrf", "rphf", "vatu"],
  ...["ljmo", "tjmo", "vjmo", "ltra", "ltrm", "rtla", "rtlm"],
]);

/** Every feature tag the face has, substitution and positioning together, in order. */
export const featureTags = (layout: LayoutFeatures): string[] =>
  [...new Set([...layout.substitution, ...layout.positioning])].sort();

export const isFeatureOn = (choices: FeatureChoices, tag: string) =>
  choices[tag] ?? ON_BY_DEFAULT.has(tag);

/** The choices after a switch. Returning a feature to its default forgets the choice. */
export const withFeature = (
  choices: FeatureChoices,
  tag: string,
  on: boolean
): FeatureChoices => {
  const { [tag]: _, ...others } = choices;
  return on === ON_BY_DEFAULT.has(tag) ? others : { ...others, [tag]: on };
};
