/**
 * The writing systems of Unicode. Characters with Script=Common or
 * Script=Inherited belong to no single script, so they are offered as shared
 * groups by general category: digits, punctuation, symbols, combining marks.
 */
import type { TextDirection } from "~/typeface/reading";
import {
  type GeneralCategory,
  propertyRuns,
  scriptOf,
  UNKNOWN_SCRIPT,
} from "./characters";
import { SCRIPTS } from "./data/properties";

export interface Script {
  /** How many assigned characters have this script. */
  readonly characterCount: number;
  /** ISO 15924, for example Deva. */
  readonly code: string;
  readonly direction: TextDirection;
  /** The Unicode name in English, for example Devanagari. */
  readonly name: string;
}

export type SharedGroupId =
  | "digits"
  | "punctuation"
  | "symbols"
  | "marks"
  | "letters"
  | "controls";

/** Characters used across scripts, grouped by what they are. */
export interface SharedGroup {
  readonly characterCount: number;
  readonly id: SharedGroupId;
  readonly name: string;
}

const SHARED_NAMES: Readonly<Record<SharedGroupId, string>> = {
  controls: "Spaces and controls",
  digits: "Digits and numbers",
  letters: "Shared letters",
  marks: "Combining marks",
  punctuation: "Punctuation",
  symbols: "Symbols",
};

const SHARED_ORDER: readonly SharedGroupId[] = [
  "digits",
  "punctuation",
  "symbols",
  "marks",
  "letters",
  "controls",
];

const SHARED_BY_CATEGORY: Readonly<Record<string, SharedGroupId>> = {
  C: "controls",
  L: "letters",
  M: "marks",
  N: "digits",
  P: "punctuation",
  S: "symbols",
  Z: "controls",
};

const COMMON = "Zyyy";
const INHERITED = "Zinh";

/** The writing systems the product explores first, in order. */
const FEATURED = ["Latn", "Grek", "Cyrl", "Arab", "Hebr", "Deva"];

const isShared = (script: string) => script === COMMON || script === INHERITED;

const groupOfCategory = (category: GeneralCategory): SharedGroupId =>
  SHARED_BY_CATEGORY[category.charAt(0)] ?? "controls";

/** Inclusive ranges as first, last, first, last. */
type Ranges = number[];

const countOf = (ranges: Ranges) => {
  let count = 0;
  for (let index = 0; index < ranges.length; index += 2) {
    count += (ranges[index + 1] ?? 0) - (ranges[index] ?? 0) + 1;
  }
  return count;
};

const expand = (ranges: Ranges) => {
  const characters = new Uint32Array(countOf(ranges));
  let offset = 0;
  for (let index = 0; index < ranges.length; index += 2) {
    const last = ranges[index + 1] ?? 0;
    for (
      let codePoint = ranges[index] ?? 0;
      codePoint <= last;
      codePoint += 1
    ) {
      characters[offset] = codePoint;
      offset += 1;
    }
  }
  return characters;
};

const buildRanges = () => {
  const byKey = new Map<string, Ranges>();
  for (const run of propertyRuns()) {
    if (run.script !== UNKNOWN_SCRIPT) {
      const key = isShared(run.script)
        ? groupOfCategory(run.category)
        : run.script;
      const ranges = byKey.get(key) ?? [];
      if (ranges.at(-1) === run.first - 1) {
        ranges[ranges.length - 1] = run.last;
      } else {
        ranges.push(run.first, run.last);
      }
      byKey.set(key, ranges);
    }
  }
  return byKey;
};

const rangesByKey = buildRanges();

const parseScripts = (): Script[] => {
  const parsed = SCRIPTS.split(";").flatMap((row): Script[] => {
    const [code = "", name = "", direction] = row.split("|");
    return isShared(code)
      ? []
      : [
          {
            characterCount: countOf(rangesByKey.get(code) ?? []),
            code,
            direction: direction === "r" ? "rtl" : "ltr",
            name,
          },
        ];
  });
  const rank = (script: Script) => {
    const featured = FEATURED.indexOf(script.code);
    return featured === -1 ? FEATURED.length : featured;
  };
  return parsed.sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "en")
  );
};

const allScripts: readonly Script[] = parseScripts();
const scriptsByCode = new Map(
  allScripts.map((script) => [script.code, script])
);

const allSharedGroups: readonly SharedGroup[] = SHARED_ORDER.map((id) => ({
  characterCount: countOf(rangesByKey.get(id) ?? []),
  id,
  name: SHARED_NAMES[id],
}));

/** Every script: the featured six first, then the rest by name. */
export const scripts = (): readonly Script[] => allScripts;

/** Latin, Greek, Cyrillic, Arabic, Hebrew and Devanagari, in that order. */
export const featuredScripts = (): readonly Script[] =>
  allScripts.slice(0, FEATURED.length);

export const findScript = (code: string): Script | undefined =>
  scriptsByCode.get(code);

export const sharedGroups = (): readonly SharedGroup[] => allSharedGroups;

export const findSharedGroup = (id: SharedGroupId): SharedGroup | undefined =>
  allSharedGroups.find((group) => group.id === id);

/** The shared group of a Common or Inherited character, otherwise undefined. */
export const sharedGroupOf = (
  codePoint: number,
  category: GeneralCategory
): SharedGroupId | undefined =>
  isShared(scriptOf(codePoint)) ? groupOfCategory(category) : undefined;

/** The assigned characters of a script code or shared group id, ascending. */
export const charactersOfGroup = (key: string): Uint32Array =>
  expand(rangesByKey.get(key) ?? []);
