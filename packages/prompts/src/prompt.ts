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

/** The same text as another dialect reads it, for spotting a sigil from the wrong harness. */
export interface SiblingReading {
  readonly dialect: Dialect;
  readonly tokens: readonly Token[];
}

export interface PromptFields {
  /** Findings from authoring, such as a reference the dialect could not write. */
  readonly authoring?: readonly Diagnostic[];
  readonly dialect: Dialect;
  readonly siblings?: readonly SiblingReading[];
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
  private readonly siblings: readonly SiblingReading[];
  private readonly sources: PromptSource;

  constructor(fields: PromptFields) {
    this.authoring = fields.authoring ?? [];
    this.dialect = fields.dialect;
    this.siblings = fields.siblings ?? [];
    this.sources = fields.sources;
    this.surface = fields.surface;
    this.text = fields.text;
    this.tokens = fields.tokens;
    this.references = locate(fields.tokens, fields.symbols ?? []);
  }

  /** Findings as of now, ordered by position. */
  get diagnostics(): readonly Diagnostic[] {
    const found = [
      ...this.authoring,
      ...diagnose(this.tokens, {
        dialect: this.dialect,
        siblings: this.siblings,
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
}

/** Thrown by a strict tag: the prompt is attached, with its diagnostics. */
export class PromptError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  readonly prompt: Prompt;

  constructor(prompt: Prompt) {
    const errors = prompt.diagnostics.filter(
      (item) => item.severity === "error"
    );
    super(
      `${prompt.dialect.label} prompt has ${errors.length} error${errors.length === 1 ? "" : "s"}: ${errors.map((item) => item.message).join(" ")}`
    );
    this.name = "PromptError";
    this.diagnostics = prompt.diagnostics;
    this.prompt = prompt;
  }
}

function locate(
  tokens: readonly Token[],
  symbols: readonly Span[]
): LocatedPromptReference[] {
  const references: LocatedPromptReference[] = [];
  for (const token of tokens) {
    if (token.reference !== undefined && token.notation !== undefined) {
      const fromSymbol = symbols.some(
        (span) => span.start <= token.span.start && token.span.end <= span.end
      );
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
