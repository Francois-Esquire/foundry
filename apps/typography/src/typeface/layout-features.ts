/**
 * Layout features: the name each tag has in the OpenType feature registry,
 * which ones a shaper applies without being asked, the features a face has,
 * and a set of them switched on and off. A shaper applies some features by
 * itself and leaves others off, so a switch only reaches the shaper when it
 * differs from that default.
 */
import type { LayoutFeatures } from "./face";

/** Registered names, in sentence case, for the tags a person is most likely to meet. */
const FEATURE_NAMES: Readonly<Record<string, string>> = {
  aalt: "Access all alternates",
  abvm: "Above-base mark positioning",
  abvs: "Above-base substitutions",
  akhn: "Akhand",
  blwf: "Below-base forms",
  blwm: "Below-base mark positioning",
  blws: "Below-base substitutions",
  c2sc: "Small capitals from capitals",
  calt: "Contextual alternates",
  case: "Case-sensitive forms",
  ccmp: "Glyph composition and decomposition",
  cjct: "Conjunct forms",
  clig: "Contextual ligatures",
  curs: "Cursive positioning",
  dist: "Distances",
  dlig: "Discretionary ligatures",
  dnom: "Denominators",
  fina: "Final forms",
  frac: "Fractions",
  half: "Half forms",
  haln: "Halant forms",
  hist: "Historical forms",
  init: "Initial forms",
  isol: "Isolated forms",
  kern: "Kerning",
  liga: "Standard ligatures",
  lnum: "Lining figures",
  locl: "Localised forms",
  mark: "Mark positioning",
  medi: "Medial forms",
  mkmk: "Mark to mark positioning",
  nukt: "Nukta forms",
  numr: "Numerators",
  onum: "Oldstyle figures",
  ordn: "Ordinals",
  pnum: "Proportional figures",
  pref: "Pre-base forms",
  pres: "Pre-base substitutions",
  psts: "Post-base substitutions",
  rclt: "Required contextual alternates",
  rkrf: "Rakar forms",
  rlig: "Required ligatures",
  rphf: "Reph form",
  rtlm: "Right-to-left mirrored forms",
  salt: "Stylistic alternates",
  sinf: "Scientific inferiors",
  size: "Optical size",
  smcp: "Small capitals",
  subs: "Subscript",
  sups: "Superscript",
  swsh: "Swash",
  titl: "Titling",
  tnum: "Tabular figures",
  vatu: "Vattu variants",
  zero: "Slashed zero",
};

const NUMBERED = /^(ss|cv)(\d{2})$/;

/** The registered name of a feature tag. Undefined for a tag with no name on file. */
export const featureName = (tag: string): string | undefined => {
  const numbered = NUMBERED.exec(tag);
  if (numbered) {
    const [, kind, digits = "0"] = numbered;
    const noun = kind === "ss" ? "Stylistic set" : "Character variant";
    return `${noun} ${Number.parseInt(digits, 10)}`;
  }
  return FEATURE_NAMES[tag];
};

/** "liga, Standard ligatures". A tag with no name on file is shown alone. */
export const featureLabel = (tag: string) => {
  const name = featureName(tag);
  return name ? `${tag}, ${name}` : tag;
};

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

/** Feature tag to on or off, holding only the features switched away from their default. */
export type FeatureChoices = Readonly<Record<string, boolean>>;

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

/** A feature block in feature code: "feature liga {". */
const WRITTEN_FEATURE = /feature\s+(\w{1,4})\s*\{/g;

/**
 * Every feature tag a face has, once, in alphabetical order: substitution
 * and positioning together, and the ones the project's own feature code
 * writes.
 */
export const featureTags = (
  layout: Pick<LayoutFeatures, "positioning" | "substitution">,
  featureCode: readonly string[] = []
): string[] =>
  [
    ...new Set([
      ...layout.substitution,
      ...layout.positioning,
      ...featureCode.flatMap((code) =>
        [...code.matchAll(WRITTEN_FEATURE)].map((match) => match[1] ?? "")
      ),
    ]),
  ].sort();
