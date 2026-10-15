import type { Dialect } from "./dialect";
import type {
  ArgumentSelector,
  Diagnostic,
  Interpolation,
  PromptReference,
  Span,
} from "./language";
import { nameOf, referenceOf } from "./reference";

export interface Rendered {
  readonly diagnostics: Diagnostic[];
  /** Where each interpolated reference landed in the text. */
  readonly symbols: Span[];
  readonly text: string;
}

/**
 * Render a template literal into prompt text. Cooked strings are used, so
 * `\${` writes a literal `${` and `` \` `` a backtick. Strings and numbers
 * are inserted as written. A reference, or a value implementing the
 * reference protocol, is written in the dialect's notation, or as its bare
 * name with a diagnostic when the dialect cannot express it.
 */
export function interpolate(
  dialect: Dialect,
  strings: TemplateStringsArray,
  values: readonly Interpolation[]
): Rendered {
  const parts: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const symbols: Span[] = [];
  let length = 0;
  const append = (piece: string) => {
    parts.push(piece);
    length += piece.length;
  };
  for (const [index, chunk] of strings.entries()) {
    if (typeof chunk !== "string") {
      throw new Error(
        "Prompt template contains an invalid escape sequence; write `\\${` for a literal `${`."
      );
    }
    append(chunk);
    const value = values[index];
    if (value === undefined) {
      continue;
    }
    const reference = referenceOf(value);
    if (reference === null) {
      append(String(value));
      continue;
    }
    const written = dialect.write(reference);
    if (written !== null) {
      symbols.push({ end: length + written.length, start: length });
      append(written);
      continue;
    }
    const fallback = bareName(reference);
    diagnostics.push({
      code: "unsupported-reference",
      message: `${dialect.label} has no notation for a ${reference.kind} reference; "${fallback}" was written as plain text.`,
      reference,
      severity: "warning",
      span: { end: length + fallback.length, start: length },
    });
    append(fallback);
  }
  return { diagnostics, symbols, text: parts.join("") };
}

function bareName(reference: PromptReference): string {
  switch (reference.kind) {
    case "argument":
      return selectorName(reference.selector);
    case "shell":
      return reference.command;
    default:
      return nameOf(reference) ?? "";
  }
}

function selectorName(selector: ArgumentSelector): string {
  if (selector.by === "all") {
    return "arguments";
  }
  return selector.by === "name" ? selector.name : String(selector.index);
}
