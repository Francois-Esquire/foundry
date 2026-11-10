/** Layout features in words, for the tags a person is most likely to meet. */
import type { Face } from "~/typeface/face";

const NAMES: Readonly<Record<string, string>> = {
  aalt: "All alternates",
  abvm: "Above-base marks",
  abvs: "Above-base forms",
  akhn: "Akhand",
  blwf: "Below-base forms",
  blwm: "Below-base marks",
  blws: "Below-base substitutions",
  c2sc: "Small capitals from capitals",
  calt: "Contextual alternates",
  case: "Case-sensitive forms",
  ccmp: "Composition and decomposition",
  cjct: "Conjuncts",
  curs: "Cursive attachment",
  dlig: "Discretionary ligatures",
  dnom: "Denominators",
  fina: "Final forms",
  frac: "Fractions",
  half: "Half forms",
  haln: "Halant forms",
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
  pres: "Pre-base substitutions",
  psts: "Post-base substitutions",
  rclt: "Required contextual alternates",
  rkrf: "Rakar forms",
  rlig: "Required ligatures",
  rphf: "Reph",
  salt: "Stylistic alternates",
  sinf: "Scientific inferiors",
  smcp: "Small capitals",
  subs: "Subscript",
  sups: "Superscript",
  tnum: "Tabular figures",
  vatu: "Vattu variants",
  zero: "Slashed zero",
};

const STYLISTIC_SET = /^ss(\d\d)$/;
const CHARACTER_VARIANT = /^cv(\d\d)$/;

/** "liga, Standard ligatures". A tag with no name on file is shown alone. */
export const featureLabel = (tag: string) => {
  const set = STYLISTIC_SET.exec(tag)?.[1];
  const variant = CHARACTER_VARIANT.exec(tag)?.[1];
  let name = NAMES[tag];
  if (set) {
    name = `Stylistic set ${Number(set)}`;
  } else if (variant) {
    name = `Character variant ${Number(variant)}`;
  }
  return name ? `${tag}, ${name}` : tag;
};

/** A feature block in feature code: "feature liga {". */
const WRITTEN_FEATURE = /feature\s+(\w{1,4})\s*\{/g;

/**
 * Every feature tag the faces have, in alphabetical order: the ones their
 * source fonts name, and the ones the project's own feature code writes.
 */
export const featureTagsOf = (
  faces: readonly Face[],
  featureCodeOf: (face: Face) => readonly string[]
): string[] =>
  [
    ...new Set(
      faces.flatMap((face) => [
        ...face.description.layout.substitution,
        ...face.description.layout.positioning,
        ...featureCodeOf(face).flatMap((code) =>
          [...code.matchAll(WRITTEN_FEATURE)].map((match) => match[1] ?? "")
        ),
      ])
    ),
  ].sort();
