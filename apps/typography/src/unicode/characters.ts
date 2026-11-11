/**
 * What Unicode says about a single character: its script, its general
 * category, whether it is assigned. Loaded eagerly; every lookup is a binary
 * search over runs.
 */
import { CATEGORY_RUNS, SCRIPT_RUNS } from "./data/properties";

const MAX_CODE_POINT = 0x10_ff_ff;

export type GeneralCategory =
  | "Lu"
  | "Ll"
  | "Lt"
  | "Lm"
  | "Lo"
  | "Mn"
  | "Mc"
  | "Me"
  | "Nd"
  | "Nl"
  | "No"
  | "Pc"
  | "Pd"
  | "Ps"
  | "Pe"
  | "Pi"
  | "Pf"
  | "Po"
  | "Sm"
  | "Sc"
  | "Sk"
  | "So"
  | "Zs"
  | "Zl"
  | "Zp"
  | "Cc"
  | "Cf"
  | "Cs"
  | "Co"
  | "Cn";

const CATEGORY_NAMES: Readonly<Record<GeneralCategory, string>> = {
  Cc: "Control",
  Cf: "Format",
  Cn: "Unassigned",
  Co: "Private Use",
  Cs: "Surrogate",
  Ll: "Lowercase Letter",
  Lm: "Modifier Letter",
  Lo: "Other Letter",
  Lt: "Titlecase Letter",
  Lu: "Uppercase Letter",
  Mc: "Spacing Mark",
  Me: "Enclosing Mark",
  Mn: "Nonspacing Mark",
  Nd: "Decimal Number",
  Nl: "Letter Number",
  No: "Other Number",
  Pc: "Connector Punctuation",
  Pd: "Dash Punctuation",
  Pe: "Close Punctuation",
  Pf: "Final Punctuation",
  Pi: "Initial Punctuation",
  Po: "Other Punctuation",
  Ps: "Open Punctuation",
  Sc: "Currency Symbol",
  Sk: "Modifier Symbol",
  Sm: "Math Symbol",
  So: "Other Symbol",
  Zl: "Line Separator",
  Zp: "Paragraph Separator",
  Zs: "Space Separator",
};

const isCategory = (value: string): value is GeneralCategory =>
  value in CATEGORY_NAMES;

/** ISO 15924 for a code point with no script: unassigned, private use, surrogate. */
export const UNKNOWN_SCRIPT = "Zzzz";

interface Runs<Value> {
  /** The first code point of each run, ascending, starting at 0. */
  readonly starts: Uint32Array;
  readonly values: readonly Value[];
}

const decodeRuns = <Value>(
  encoded: string,
  token: RegExp,
  toValue: (text: string) => Value
): Runs<Value> => {
  const starts: number[] = [];
  const values: Value[] = [];
  let next = 0;
  for (const [, length = "", value = ""] of encoded.matchAll(token)) {
    starts.push(next);
    values.push(toValue(value));
    next += length === "" ? 1 : Number.parseInt(length, 36);
  }
  return { starts: Uint32Array.from(starts), values };
};

const scriptRuns = decodeRuns(
  SCRIPT_RUNS,
  /([0-9a-z]*)([A-Z][a-z]{3})/g,
  (code) => code
);

const categoryRuns = decodeRuns(
  CATEGORY_RUNS,
  /([0-9a-z]*)([A-Z][a-z])/g,
  (code): GeneralCategory => (isCategory(code) ? code : "Cn")
);

/** The index of the run holding the code point. */
const runIndex = (starts: Uint32Array, codePoint: number) => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= codePoint) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

export const isCodePoint = (value: number) =>
  Number.isInteger(value) && value >= 0 && value <= MAX_CODE_POINT;

/** The ISO 15924 code of a character's script: Deva, Zyyy for Common, Zinh for Inherited. */
export const scriptOf = (codePoint: number): string =>
  isCodePoint(codePoint)
    ? (scriptRuns.values[runIndex(scriptRuns.starts, codePoint)] ??
      UNKNOWN_SCRIPT)
    : UNKNOWN_SCRIPT;

export const categoryOf = (codePoint: number): GeneralCategory =>
  isCodePoint(codePoint)
    ? (categoryRuns.values[runIndex(categoryRuns.starts, codePoint)] ?? "Cn")
    : "Cn";

export const categoryName = (category: GeneralCategory) =>
  CATEGORY_NAMES[category];

/** Spaces, line ends, controls and format characters draw nothing of their own. */
const DRAWS_NOTHING: ReadonlySet<GeneralCategory> = new Set([
  "Cc",
  "Cf",
  "Zl",
  "Zp",
  "Zs",
]);

/**
 * True for a character no font has to hold: it leaves no mark on the page.
 * Private use and unassigned characters do draw, so a font that lacks one
 * shows the crossed box.
 */
export const drawsNothing = (codePoint: number) =>
  DRAWS_NOTHING.has(categoryOf(codePoint));

/** Unassigned means general category Cn. Private use and surrogates are assigned. */
export const isAssigned = (codePoint: number) => categoryOf(codePoint) !== "Cn";

export const isCombiningMark = (codePoint: number) =>
  categoryOf(codePoint).startsWith("M");

/** A stretch of code points that share a script and a general category. */
export interface PropertyRun {
  readonly category: GeneralCategory;
  readonly first: number;
  readonly last: number;
  readonly script: string;
}

/** Every run of the code space from `first` to `last`, ascending. */
export function* propertyRuns(
  first = 0,
  last = MAX_CODE_POINT
): Generator<PropertyRun> {
  let scriptIndex = runIndex(scriptRuns.starts, first);
  let categoryIndex = runIndex(categoryRuns.starts, first);
  let start = first;
  while (start <= last) {
    const scriptEnd = scriptRuns.starts[scriptIndex + 1] ?? MAX_CODE_POINT + 1;
    const categoryEnd =
      categoryRuns.starts[categoryIndex + 1] ?? MAX_CODE_POINT + 1;
    const end = Math.min(scriptEnd, categoryEnd, last + 1);
    yield {
      category: categoryRuns.values[categoryIndex] ?? "Cn",
      first: start,
      last: end - 1,
      script: scriptRuns.values[scriptIndex] ?? UNKNOWN_SCRIPT,
    };
    if (end === scriptEnd) {
      scriptIndex += 1;
    }
    if (end === categoryEnd) {
      categoryIndex += 1;
    }
    start = end;
  }
}
