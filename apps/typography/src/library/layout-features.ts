/**
 * Layout features as a specimen offers them: a readable name, whether shaping
 * applies the feature without being asked, and the settings a set of choices
 * comes to.
 */

const NAMES: Readonly<Record<string, string>> = {
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

/** The registered name of a feature tag. Undefined for a tag with no usual name. */
export const featureName = (tag: string): string | undefined => {
  const numbered = NUMBERED.exec(tag);
  if (numbered) {
    const [, kind, digits = "0"] = numbered;
    const noun = kind === "ss" ? "Stylistic set" : "Character variant";
    return `${noun} ${Number.parseInt(digits, 10)}`;
  }
  return NAMES[tag];
};

/**
 * Features a shaping engine applies without being asked: the general ones,
 * and the forms a script cannot be set without.
 */
const ON_BY_DEFAULT = new Set([
  "abvm",
  "abvs",
  "akhn",
  "blwf",
  "blwm",
  "blws",
  "calt",
  "ccmp",
  "cjct",
  "clig",
  "curs",
  "dist",
  "fina",
  "half",
  "haln",
  "init",
  "isol",
  "kern",
  "liga",
  "locl",
  "mark",
  "medi",
  "mkmk",
  "nukt",
  "pref",
  "pres",
  "psts",
  "rclt",
  "rkrf",
  "rlig",
  "rphf",
  "rtlm",
  "vatu",
]);

const isOnByDefault = (tag: string) => ON_BY_DEFAULT.has(tag);

/** Feature tags someone switched away from their default, with the state chosen. */
export type FeatureChoices = Readonly<Record<string, boolean>>;

export const isFeatureOn = (choices: FeatureChoices, tag: string) =>
  choices[tag] ?? isOnByDefault(tag);

/** Switches a feature. A choice that matches the default is dropped again. */
export const chooseFeature = (
  choices: FeatureChoices,
  tag: string,
  on: boolean
): FeatureChoices => {
  const { [tag]: _previous, ...rest } = choices;
  return on === isOnByDefault(tag) ? rest : { ...rest, [tag]: on };
};

/** The choices as a CSS `font-feature-settings` value, for example `"liga" 0`. */
export const fontFeatureSettings = (choices: FeatureChoices) =>
  Object.keys(choices)
    .sort()
    .map((tag) => `"${tag}" ${choices[tag] ? 1 : 0}`)
    .join(", ") || "normal";

/** Every feature of a face once, substitution and positioning together, by tag. */
export const featureTags = (layout: {
  readonly positioning: readonly string[];
  readonly substitution: readonly string[];
}): string[] =>
  [...new Set([...layout.substitution, ...layout.positioning])].sort();
