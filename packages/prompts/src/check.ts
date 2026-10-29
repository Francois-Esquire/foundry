import type { Dialect } from "./dialect";
import type {
  Diagnostic,
  Notation,
  PromptReference,
  PromptSource,
  ReferenceToken,
  Span,
  Surface,
  Token,
} from "./language";
import { nameOf } from "./reference";
import { SpanSet } from "./spans";

export interface CheckContext {
  readonly dialect: Dialect;
  /** The same text as each other dialect reads it, in the order the host declared them. */
  readonly siblings: ReadonlyMap<Dialect, readonly Token[]>;
  /** What exists, the dialect's built-ins included. */
  readonly sources: PromptSource;
  readonly surface: Surface;
}

/** A reference a wrong sigil is reported for: names a host lists, never harness-private ones. */
type ForeignReference = Extract<PromptReference, { kind: "agent" | "skill" }>;

const FOREIGN_KINDS: ReadonlySet<PromptReference["kind"]> = new Set([
  "agent",
  "skill",
]);

function isForeign(reference: PromptReference): reference is ForeignReference {
  return FOREIGN_KINDS.has(reference.kind);
}

/** Findings for one prompt's tokens against what exists. */
export function diagnose(
  tokens: readonly Token[],
  context: CheckContext
): Diagnostic[] {
  const foreign = foreignNotation(tokens, context);
  const foreignSpans = new SpanSet(foreign.map((item) => item.span));
  const found: Diagnostic[] = [...foreign];
  for (const token of tokens) {
    if (!("reference" in token)) {
      continue;
    }
    const item = context.dialect.notation(token.notation);
    if (item === undefined) {
      continue;
    }
    if (foreignSpans.overlaps(token.span)) {
      continue;
    }
    found.push(...placement(token, item, context));
    const unresolved = resolution(token, context.sources);
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
  const read = ownReadings(own);
  for (const [sibling, tokens] of context.siblings) {
    for (const token of tokens) {
      if (!("reference" in token)) {
        continue;
      }
      const { reference } = token;
      if (
        !(
          isForeign(reference) &&
          context.sources.has(reference.kind, reference.name)
        )
      ) {
        continue;
      }
      if (readsTheSame(read, token.span, reference)) {
        continue;
      }
      const right = context.dialect.write({
        kind: reference.kind,
        name: reference.name,
      });
      found.push({
        code: "foreign-notation",
        message: `"${token.text}" is ${sibling.label} notation; ${context.dialect.label} ${right === null ? `has no notation for a ${reference.kind}` : `reads a ${reference.kind} as "${right}"`}.`,
        reference,
        severity: "error",
        span: token.span,
      });
    }
  }
  return dedupe(found);
}

type Readings = Map<PromptReference["kind"], Map<string | undefined, SpanSet>>;

/**
 * Where the own dialect read each reference, by kind and then name, so a
 * sibling's reading is compared with the same reference only.
 */
function ownReadings(own: readonly Token[]): Readings {
  const spans = new Map<
    PromptReference["kind"],
    Map<string | undefined, Span[]>
  >();
  for (const token of own) {
    if (!("reference" in token)) {
      continue;
    }
    const { kind } = token.reference;
    const name = nameOf(token.reference);
    const byName = spans.get(kind) ?? new Map<string | undefined, Span[]>();
    spans.set(kind, byName);
    const found = byName.get(name) ?? [];
    byName.set(name, found);
    found.push(token.span);
  }
  const read: Readings = new Map();
  for (const [kind, byName] of spans) {
    const sets = new Map<string | undefined, SpanSet>();
    for (const [name, found] of byName) {
      sets.set(name, new SpanSet(found));
    }
    read.set(kind, sets);
  }
  return read;
}

/** The own dialect already found the same reference at this place. */
function readsTheSame(
  read: Readings,
  span: Span,
  reference: PromptReference
): boolean {
  return (
    read.get(reference.kind)?.get(nameOf(reference))?.overlaps(span) ?? false
  );
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
  token: ReferenceToken,
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

/** Unresolved when some layer covers the kind and none has the name. */
function resolution(
  token: ReferenceToken,
  sources: PromptSource
): Diagnostic | null {
  const { reference } = token;
  const name = nameOf(reference);
  if (name === undefined) {
    return null;
  }
  if (!sources.covers(reference.kind) || sources.has(reference.kind, name)) {
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
