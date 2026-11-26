import type { Dialect } from "./dialect";
import type { Notation, Surface } from "./notation";
import type { ReferenceToken, Token } from "./parser";
import type { PromptReference } from "./reference";
import { nameOf } from "./reference";
import type { PromptSource } from "./source";
import type { Span } from "./spans";
import { SpanSet } from "./spans";

export interface CheckContext {
  readonly dialect: Dialect;
  readonly siblings: ReadonlyMap<Dialect, readonly Token[]>;
  readonly sources: PromptSource;
  readonly surface: Surface;
}

type ForeignReference = Extract<PromptReference, { kind: "agent" | "skill" }>;

const FOREIGN_KINDS: ReadonlySet<PromptReference["kind"]> = new Set([
  "agent",
  "skill",
]);

function isForeign(reference: PromptReference): reference is ForeignReference {
  return FOREIGN_KINDS.has(reference.kind);
}

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

function foreignNotation(
  own: readonly Token[],
  context: CheckContext
): Diagnostic[] {
  const found: Diagnostic[] = [];
  let read: Readings | undefined;
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
      read ??= ownReadings(own);
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

export type DiagnosticCode =
  | "consumed-by-harness"
  | "foreign-notation"
  | "misread-reference"
  | "template-only"
  | "unresolved-reference"
  | "unsupported-reference";

export type DiagnosticSeverity = "error" | "info" | "warning";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly reference?: PromptReference;
  readonly severity: DiagnosticSeverity;
  readonly span: Span;
}
