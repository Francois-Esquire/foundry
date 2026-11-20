import type { Dialect } from "./dialect";
import type { MatchContext, Notation, PromptSource, Token } from "./language";

const BLANK = /\S/;

export class Parser {
  readonly dialect: Dialect;
  private readonly source: PromptSource;

  constructor(dialect: Dialect, source: PromptSource = dialect.builtins) {
    this.dialect = dialect;
    this.source = source;
  }

  tokenize(text: string): Token[] {
    return this.scan(text, 0, firstNonBlank(text));
  }

  tokenizeTemplate(chunks: readonly string[]): Token[] {
    const tokens: Token[] = [];
    let offset = 0;
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) {
        tokens.push({
          kind: "hole",
          span: { end: offset, start: offset },
          text: "",
        });
      }
      const start = index === 0 ? firstNonBlank(chunk) : -1;
      for (const token of this.scan(chunk, offset, start)) {
        tokens.push(token);
      }
      offset += chunk.length;
    }
    return tokens;
  }

  private scan(text: string, offset: number, start: number): Token[] {
    const tokens: Token[] = [];
    const knows: MatchContext["knows"] = (kind, name) =>
      this.source.has(kind, name);
    let textStart = 0;
    let at = 0;
    while (at < text.length) {
      const context: MatchContext = { atStart: at === start, knows };
      const hit = matchAt(text, at, this.dialect.notations, context);
      if (hit === null) {
        at += 1;
        continue;
      }
      if (textStart < at) {
        tokens.push(textToken(text, textStart, at, offset));
      }
      tokens.push(shift(hit, offset));
      at = hit.span.end;
      textStart = at;
    }
    if (textStart < text.length) {
      tokens.push(textToken(text, textStart, text.length, offset));
    }
    return tokens;
  }
}

function shift(token: Token, offset: number): Token {
  return offset === 0
    ? token
    : {
        ...token,
        span: {
          end: token.span.end + offset,
          start: token.span.start + offset,
        },
      };
}

function firstNonBlank(text: string): number {
  const index = text.search(BLANK);
  return index === -1 ? text.length : index;
}

function textToken(
  text: string,
  start: number,
  end: number,
  offset: number
): Token {
  return {
    kind: "text",
    span: { end: end + offset, start: start + offset },
    text: text.slice(start, end),
  };
}

function matchAt(
  text: string,
  at: number,
  notations: readonly Notation[],
  context: MatchContext
): Token | null {
  for (const candidate of notations) {
    if (candidate.position === "start" && !context.atStart) {
      continue;
    }
    const matched = candidate.match(text, at, context);
    if (matched === null || matched.end <= at) {
      continue;
    }
    const span = { end: matched.end, start: at };
    const slice = text.slice(at, matched.end);
    return matched.reference === undefined
      ? { kind: "escape", span, text: slice }
      : {
          kind: matched.reference.kind,
          notation: candidate.id,
          reference: matched.reference,
          span,
          text: slice,
        };
  }
  return null;
}
