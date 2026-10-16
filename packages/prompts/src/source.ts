import { type NameLookup, referenceSource } from "@foundry/core/agents";
import type { PromptReferenceKind, PromptSource } from "./language";

/**
 * The names of one kind: listed, or a predicate when the set is open or
 * lazy. A listed iterable is read once; pass a predicate for a live source
 * such as a registry that changes between turns.
 */
export type Membership = Iterable<string> | NameLookup;

/** Names by reference kind. A kind left out is not covered, so not validated. */
export type PromptNames = Partial<Record<PromptReferenceKind, Membership>>;

export function isSource(
  value: PromptSource | PromptNames
): value is PromptSource {
  return typeof (value as PromptSource).has === "function";
}

/** A source from listed names or predicates. */
export function namesSource(members: PromptNames): PromptSource {
  const lookups: Partial<Record<PromptReferenceKind, NameLookup>> = {};
  for (const [kind, membership] of Object.entries(members)) {
    if (membership !== undefined) {
      lookups[kind as PromptReferenceKind] = lookup(membership);
    }
  }
  return referenceSource(lookups);
}

function lookup(membership: Membership): NameLookup {
  if (typeof membership === "function") {
    return membership;
  }
  const names = new Set(membership);
  return (name) => names.has(name);
}

/**
 * One source over several: a kind is covered when any layer covers it, and
 * a name resolves when any layer has it. The layers are read on every
 * lookup, so one added to the array later counts.
 */
export function layered(layers: readonly PromptSource[]): PromptSource {
  return {
    covers: (kind) => layers.some((layer) => layer.covers(kind)),
    has: (kind, name) => layers.some((layer) => layer.has(kind, name)),
  };
}
