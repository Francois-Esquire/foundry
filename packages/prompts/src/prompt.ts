import { diagnose } from "./check";
import type { Dialect } from "./dialect";
import type {
  Diagnostic,
  LocatedPromptReference,
  PromptSource,
  Span,
  Surface,
  Token,
} from "./language";
import { Parser } from "./parser";

interface PromptFields {
  /** Findings from authoring, such as a reference the dialect could not write. */
  readonly authoring?: readonly Diagnostic[];
  readonly dialect: Dialect;
  /** The other dialects a host authors in, for spotting a sigil from the wrong harness. */
  readonly siblings?: readonly Dialect[];
  readonly sources: PromptSource;
  readonly surface: Surface;
  /** Where interpolated references landed; references inside them have origin `symbol`. */
  readonly symbols?: readonly Span[];
  readonly text: string;
  readonly tokens: readonly Token[];
}

/**
 * An authored prompt: the text as the harness would receive it, the dialect
 * it was written in, and everything it references. `diagnostics` and `ok`
 * are read against what exists each time, so a skill or agent defined
 * after the prompt was written resolves on the next read.
 */
export class Prompt {
  readonly dialect: Dialect;
  readonly references: readonly LocatedPromptReference[];
  readonly surface: Surface;
  readonly text: string;
  readonly tokens: readonly Token[];
  private readonly authoring: readonly Diagnostic[];
  private readonly siblings: readonly Dialect[];
  private readonly sources: PromptSource;
  /** The text as each sibling reads it; tokens depend only on the text, so read once. */
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
      ...unread(fields.text, fields.tokens, symbols, fields.dialect),
    ];
  }

  /** Findings as of now, ordered by position. */
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

  /** True when no diagnostic is an error, as of now. */
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

/** Thrown by a strict tag: the prompt is attached, with its diagnostics. */
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
  symbols: readonly Span[]
): LocatedPromptReference[] {
  const references: LocatedPromptReference[] = [];
  for (const token of tokens) {
    if ("reference" in token) {
      const fromSymbol = symbols.some((span) => within(token.span, span));
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

/**
 * An interpolated reference the dialect wrote but does not read where it
 * sits: a start-only invocation in the middle of a message, or a sigil
 * that landed against a word. The harness will see plain text there, so
 * say so.
 */
function unread(
  text: string,
  tokens: readonly Token[],
  symbols: readonly Span[],
  dialect: Dialect
): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const span of symbols) {
    const read = tokens.some(
      (token) => "reference" in token && within(token.span, span)
    );
    if (!read) {
      const written = text.slice(span.start, span.end);
      found.push({
        code: "unsupported-reference",
        message: `${dialect.label} does not read "${written}" as a reference where it sits; it is sent as plain text.`,
        severity: "warning",
        span,
      });
    }
  }
  return found;
}

function within(inner: Span, outer: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}
