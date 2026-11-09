/**
 * What typed contents are before anything is calculated. Sheets decides
 * this, not the formula engine, so the same contents mean the same value
 * under any engine. The FormulaEngine specification requires engines to
 * read contents this way.
 */
export type ReadContents =
  | { readonly kind: "boolean"; readonly value: boolean }
  /** The formula as typed, starting with `=`. */
  | { readonly kind: "formula"; readonly formula: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly value: string };

/** Optional sign, digits with an optional fraction, optional exponent. */
const NUMERAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const BOOLEAN = /^(true|false)$/i;

/**
 * Reads contents: `=` starts a formula, a leading `'` makes the rest text,
 * a plain numeral is a number, `TRUE` or `FALSE` in any case is a boolean,
 * and anything else is text. `10%`, `$10`, `1,000`, ` 12` and dates are
 * text. A numeral too large for a number (`1e999`) is text too.
 */
export function readContents(contents: string): ReadContents {
  if (contents.startsWith("=")) {
    return { formula: contents, kind: "formula" };
  }
  if (contents.startsWith("'")) {
    return { kind: "text", value: contents.slice(1) };
  }
  if (NUMERAL.test(contents)) {
    const value = Number(contents);
    if (Number.isFinite(value)) {
      return { kind: "number", value };
    }
  }
  if (BOOLEAN.test(contents)) {
    return { kind: "boolean", value: contents.toLowerCase() === "true" };
  }
  return { kind: "text", value: contents };
}
