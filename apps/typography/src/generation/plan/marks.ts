/**
 * What the plan and the procedural strategy know about combining marks: how
 * each attaches to a base, and which spacing character draws the same mark.
 */

export type MarkAttachment =
  | "above"
  | "below"
  | "cedilla"
  | "ogonek"
  | "overlay";

/** Combining marks that hang from the base instead of sitting above it. */
const BELOW: readonly (readonly [number, number])[] = [
  [0x03_16, 0x03_19],
  [0x03_1c, 0x03_20],
  [0x03_23, 0x03_26],
  [0x03_29, 0x03_33],
  [0x03_39, 0x03_3c],
  [0x03_47, 0x03_49],
  [0x03_4d, 0x03_4e],
  [0x03_53, 0x03_56],
];
const OVERLAY: readonly [number, number] = [0x03_34, 0x03_38];
const CEDILLA = 0x03_27;
const OGONEK = 0x03_28;

/** The spacing character that draws the same mark, where Unicode has one. */
const SPACING_FORMS: ReadonlyMap<number, number> = new Map([
  [0x03_00, 0x00_60],
  [0x03_01, 0x00_b4],
  [0x03_02, 0x02_c6],
  [0x03_03, 0x02_dc],
  [0x03_04, 0x00_af],
  [0x03_06, 0x02_d8],
  [0x03_07, 0x02_d9],
  [0x03_08, 0x00_a8],
  [0x03_0a, 0x02_da],
  [0x03_0b, 0x02_dd],
  [0x03_0c, 0x02_c7],
  [CEDILLA, 0x00_b8],
  [OGONEK, 0x02_db],
]);

/** Letters whose dot gives way to a mark above, with their dotless forms. */
const DOTLESS_FORMS: ReadonlyMap<number, number> = new Map([
  [0x00_69, 0x01_31],
  [0x00_6a, 0x02_37],
]);

const MARK = /\p{M}/u;

const isCombiningMark = (character: number) =>
  MARK.test(String.fromCodePoint(character));

export const markAttachment = (mark: number): MarkAttachment => {
  if (mark === CEDILLA) {
    return "cedilla";
  }
  if (mark === OGONEK) {
    return "ogonek";
  }
  if (mark >= OVERLAY[0] && mark <= OVERLAY[1]) {
    return "overlay";
  }
  return BELOW.some(([first, last]) => mark >= first && mark <= last)
    ? "below"
    : "above";
};

/** The characters whose glyph can draw a mark: the combining mark, then its spacing form. */
export const markForms = (mark: number): number[] => {
  const spacing = SPACING_FORMS.get(mark);
  return spacing === undefined ? [mark] : [mark, spacing];
};

export const dotlessForm = (character: number) => DOTLESS_FORMS.get(character);

/**
 * The parts of a character by Unicode canonical decomposition: a base and
 * the marks on it. Nothing for a character that does not decompose that way.
 */
export const decompose = (
  character: number
): { readonly base: number; readonly marks: number[] } | undefined => {
  const [base, ...marks] = [
    ...String.fromCodePoint(character).normalize("NFD"),
  ].map((part) => part.codePointAt(0) ?? 0);
  return base !== undefined && marks.length > 0 && marks.every(isCombiningMark)
    ? { base, marks }
    : undefined;
};
