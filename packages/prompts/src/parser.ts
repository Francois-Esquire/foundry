import type { Dialect } from "./dialect";
import type { MatchContext, Notation, Token } from "./language";

const BLANK = /\S/;

/**
 * Extraction only: text in, tokens out. Knows the dialect's grammar and
 * nothing about what exists; that is the prompt sources' concern.
 */
export class Parser {
  readonly dialect: Dialect;

  constructor(dialect: Dialect) {
    this.dialect = dialect;
  }

  /**
   * Split a prompt into tokens. At each position the notations are tried in
   * order and the first match wins; everything else is text. A notation
   * whose `position` is `start` is only offered the first non-blank position.
   */
  tokenize(text: string): Token[] {
    return this.scan(text, 0, firstNonBlank(text));
  }

  /**
   * Read a template statically: its literal chunks with a `hole` token
   * where each interpolation sits. Spans are offsets into the chunks joined
   * as written; a hole has no width. No notation spans a hole, so a sigil
   * left dangling before one is text, and a static tool reports the hole
   * as a dynamic reference rather than an unknown one.
   */
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
      tokens.push(...this.scan(chunk, offset, start));
      offset += chunk.length;
    }
    return tokens;
  }

  private scan(text: string, offset: number, start: number): Token[] {
    const tokens: Token[] = [];
    const { builtins } = this.dialect;
    const knows: MatchContext["knows"] = (kind, name) =>
      builtins.has(kind, name);
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
