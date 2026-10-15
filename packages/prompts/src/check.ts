import type { Dialect } from "./dialect";
import { nameOf } from "./dialect";
import type {
  Diagnostic,
  Notation,
  PromptReference,
  PromptSource,
  Span,
  Surface,
  Token,
} from "./language";
import type { SiblingReading } from "./prompt";

export interface CheckContext {
  readonly dialect: Dialect;
  readonly siblings: readonly SiblingReading[];
  readonly sources: PromptSource;
  readonly surface: Surface;
}

/** Kinds a wrong sigil is reported for: names a host lists, never harness-private ones. */
const FOREIGN_KINDS: ReadonlySet<PromptReference["kind"]> = new Set([
  "agent",
  "skill",
]);

/** Findings for one prompt's tokens against the dialect's built-ins and what exists. */
export function diagnose(
  tokens: readonly Token[],
  context: CheckContext
): Diagnostic[] {
  const foreign = foreignNotation(tokens, context);
  const found: Diagnostic[] = [...foreign];
  for (const token of tokens) {
    const item =
      token.notation === undefined
        ? undefined
        : context.dialect.notation(token.notation);
    if (item === undefined || token.reference === undefined) {
      continue;
    }
    if (foreign.some((other) => overlaps(other.span, token.span))) {
      continue;
    }
    found.push(...placement(token, item, context));
    const unresolved = resolution(token, token.reference, context);
    if (unresolved !== null) {
      found.push(unresolved);
    }
  }
  return found;
}

/**
 * A skill or agent written in another dialect's notation, when the name is
 * one this host has. `$review` in a Claude Code prompt is almost certainly
 * `/review`; `$5` or a stray `@` never trips this, since nothing by that
 * name exists.
 */
function foreignNotation(
  own: readonly Token[],
  context: CheckContext
): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const sibling of context.siblings) {
    for (const token of sibling.tokens) {
      const { reference } = token;
      if (reference === undefined || !FOREIGN_KINDS.has(reference.kind)) {
        continue;
      }
      const name = nameOf(reference);
      if (name === undefined || !context.sources.has(reference.kind, name)) {
        continue;
      }
      if (readsTheSame(own, token.span, reference)) {
        continue;
      }
      const right = context.dialect.write(
        reference.kind === "skill"
          ? { kind: "skill", name }
          : { kind: "agent", name }
      );
      found.push({
        code: "foreign-notation",
        message: `"${token.text}" is ${sibling.dialect.label} notation; ${context.dialect.label} ${right === null ? `has no notation for a ${reference.kind}` : `reads a ${reference.kind} as "${right}"`}.`,
        reference,
        severity: "error",
        span: token.span,
      });
    }
  }
  return dedupe(found);
}

/** The own dialect already found the same reference at this place. */
function readsTheSame(
  own: readonly Token[],
  span: Span,
  reference: PromptReference
): boolean {
  return own.some(
    (token) =>
      token.reference !== undefined &&
      token.reference.kind === reference.kind &&
      nameOf(token.reference) === nameOf(reference) &&
      overlaps(token.span, span)
  );
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((item) => {
    const key = `${item.span.start}:${item.span.end}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function placement(
  token: Token,
  item: Notation,
  context: CheckContext
): Diagnostic[] {
  const found: Diagnostic[] = [];
  const { label } = context.dialect;
  if (item.surface === "template" && context.surface === "message") {
    found.push({
      code: "template-only",
      message: `${label} substitutes "${token.text}" only inside a skill or template file; in a message it is sent as literal text.`,
      reference: token.reference,
      severity: "warning",
      span: token.span,
    });
  }
  if (item.consumes) {
    found.push({
      code: "consumed-by-harness",
      message: `${label} handles "${token.text}" itself; the model does not receive this message.`,
      reference: token.reference,
      severity: "warning",
      span: token.span,
    });
  }
  return found;
}

function resolution(
  token: Token,
  reference: PromptReference,
  context: CheckContext
): Diagnostic | null {
  const name = nameOf(reference);
  if (name === undefined) {
    return null;
  }
  const { builtins } = context.dialect;
  const { sources } = context;
  const covered =
    builtins.covers(reference.kind) || sources.covers(reference.kind);
  if (!covered) {
    return null;
  }
  const resolved =
    builtins.has(reference.kind, name) || sources.has(reference.kind, name);
  if (resolved) {
    return null;
  }
  return {
    code: "unresolved-reference",
    message: `Unknown ${reference.kind} "${name}".`,
    reference,
    severity: "error",
    span: token.span,
  };
}
