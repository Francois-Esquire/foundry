import type { PromptReferenceKind, PromptSource } from "./language";

/**
 * The names of one kind: listed, or a predicate when the set is open or
 * lazy. A listed iterable is read once; pass a predicate for a live source
 * such as a registry that changes between turns.
 */
export type Membership = Iterable<string> | ((name: string) => boolean);

/** Names by reference kind. A kind left out is not covered, so not validated. */
export type PromptNames = Partial<Record<PromptReferenceKind, Membership>>;

export function isSource(
  value: PromptSource | PromptNames
): value is PromptSource {
  return typeof (value as PromptSource).has === "function";
}

/** A source from listed names or predicates. */
export function namesSource(members: PromptNames): PromptSource {
  const lookups = new Map<PromptReferenceKind, (name: string) => boolean>();
  for (const [kind, membership] of Object.entries(members)) {
    if (membership !== undefined) {
      lookups.set(kind as PromptReferenceKind, lookup(membership));
    }
  }
  return {
    covers: (kind) => lookups.has(kind),
    has: (kind, name) => lookups.get(kind)?.(name) ?? false,
  };
}

function lookup(membership: Membership): (name: string) => boolean {
  if (typeof membership === "function") {
    return membership;
  }
  const names = new Set(membership);
  return (name) => names.has(name);
}
