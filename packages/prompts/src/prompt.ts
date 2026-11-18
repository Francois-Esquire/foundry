import type { Interpolated } from "./author";
import { diagnose } from "./check";
import type { Dialect } from "./dialect";
import type {
  Diagnostic,
  LocatedPromptReference,
  PromptReference,
  PromptSource,
  ReferenceToken,
  Span,
  Surface,
  Token,
} from "./language";
import { Parser } from "./parser";
import { nameOf } from "./reference";
import { SpanSet } from "./spans";

interface PromptFields {
  readonly authoring?: readonly Diagnostic[];
  readonly dialect: Dialect;
  readonly siblings?: readonly Dialect[];
  readonly sources: PromptSource;
  readonly surface: Surface;
  readonly symbols?: readonly Interpolated[];
  readonly text: string;
  readonly tokens: readonly Token[];
}

export class Prompt {
  readonly dialect: Dialect;
  readonly references: readonly LocatedPromptReference[];
  readonly surface: Surface;
  readonly text: string;
  readonly tokens: readonly Token[];
  private readonly authoring: readonly Diagnostic[];
  private readonly siblings: readonly Dialect[];
  private readonly sources: PromptSource;
  private readings: ReadonlyMap<Dialect, readonly Token[]> | undefined;

  constructor(fields: PromptFields) {
    const symbols = fields.symbols ?? [];
    this.dialect = fields.dialect;
    this.siblings = fields.siblings ?? [];
    this.sources = fields.sources;
    this.surface = fields.surface;
    this.text = fields.text;
    this.tokens = fields.tokens;
    this.references = locate(fields.tokens, symbols);
    this.authoring = [
      ...(fields.authoring ?? []),
      ...readBack(fields.text, fields.tokens, symbols, fields.dialect),
    ];
  }

  get diagnostics(): readonly Diagnostic[] {
    const found = [
      ...this.authoring,
      ...diagnose(this.tokens, {
        dialect: this.dialect,
        siblings: this.siblingReadings(),
        sources: this.sources,
        surface: this.surface,
      }),
    ];
    return found.sort((a, b) => a.span.start - b.span.start);
  }

  get ok(): boolean {
    return !this.diagnostics.some((item) => item.severity === "error");
  }

  toString(): string {
    return this.text;
  }

  private siblingReadings(): ReadonlyMap<Dialect, readonly Token[]> {
    this.readings ??= new Map(
      this.siblings.map((sibling) => [
        sibling,
        new Parser(sibling).tokenize(this.text),
      ])
    );
    return this.readings;
  }
}

export class PromptError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  readonly prompt: Prompt;

  constructor(
    prompt: Prompt,
    diagnostics: readonly Diagnostic[] = prompt.diagnostics
  ) {
    const errors = diagnostics.filter((item) => item.severity === "error");
    super(
      `${prompt.dialect.label} prompt has ${errors.length} error${errors.length === 1 ? "" : "s"}: ${errors.map((item) => item.message).join(" ")}`
    );
    this.name = "PromptError";
    this.diagnostics = diagnostics;
    this.prompt = prompt;
  }
}

function locate(
  tokens: readonly Token[],
  symbols: readonly Interpolated[]
): LocatedPromptReference[] {
  const references: LocatedPromptReference[] = [];
  const symbolSpans = new SpanSet(symbols.map((symbol) => symbol.span));
  for (const token of tokens) {
    if ("reference" in token) {
      const fromSymbol = symbolSpans.contains(token.span);
      references.push({
        ...token.reference,
        notation: token.notation,
        origin: fromSymbol ? "symbol" : "text",
        span: token.span,
      });
    }
  }
  return references;
}

function readBack(
  text: string,
  tokens: readonly Token[],
  symbols: readonly Interpolated[],
  dialect: Dialect
): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const { reference, span } of symbols) {
    const read = referencesWithin(tokens, span);
    if (read.some((token) => sameReference(token.reference, reference))) {
      continue;
    }
    const written = text.slice(span.start, span.end);
    const [other] = read;
    found.push(
      other === undefined
        ? {
            code: "unsupported-reference",
            message: `${dialect.label} does not read "${written}" as a reference where it sits; it is sent as plain text.`,
            reference,
            severity: "warning",
            span,
          }
        : {
            code: "misread-reference",
            message: `${dialect.label} reads "${written}" as ${describe(other.reference)} here, not ${describe(reference)} as written.`,
            reference,
            severity: "error",
            span,
          }
    );
  }
  return found;
}

function sameReference(
  read: PromptReference,
  written: PromptReference
): boolean {
  return read.kind === written.kind && nameOf(read) === nameOf(written);
}

function describe(reference: PromptReference): string {
  const name = nameOf(reference);
  if (name === undefined) {
    return `${reference.kind === "argument" ? "an" : "a"} ${reference.kind}`;
  }
  return `the ${reference.kind} "${name}"`;
}

function referencesWithin(
  tokens: readonly Token[],
  span: Span
): ReferenceToken[] {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((tokens[middle]?.span.start ?? 0) < span.start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const found: ReferenceToken[] = [];
  for (let at = low; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === undefined || token.span.end > span.end) {
      break;
    }
    if ("reference" in token) {
      found.push(token);
    }
  }
  return found;
}
