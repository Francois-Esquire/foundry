export type ReadContents =
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "formula"; readonly formula: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly value: string };

const NUMERAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const BOOLEAN = /^(true|false)$/i;

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
