/**
 * What can be referred to by name across Foundry, and how a value says what
 * it refers to. Generic on purpose: the prompts package extends the kinds
 * with its own notation-only ones, the agents package marks its skills and
 * agents as referenceable, and neither depends on the other for it.
 */

/** The things a name can point at: the catalog entities a host resolves. */
export type ReferenceKind = "agent" | "file" | "mcp" | "skill";

/**
 * A reference as meant, independent of how it was written. `name` is the
 * full identifier a host resolves, namespace included (`plugin:skill`), so
 * it compares directly against what exists. A file's name is its path.
 */
export type Reference =
  | { readonly kind: "agent"; readonly name: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "mcp"; readonly name: string }
  | { readonly kind: "skill"; readonly name: string };

/**
 * The well-known symbol a value implements to say what it refers to. A
 * virtual skill or a code-declared agent carries it, so wherever the value
 * is used in place of a name, the name is taken from the value, and a
 * static tool resolves the identifier through the type checker instead of
 * looking the name up.
 */
export const REFERENCE: unique symbol = Symbol.for("@foundry/reference");

/** Something that can stand in for a name: it knows the reference it is. */
export interface Referenceable<K extends ReferenceKind = ReferenceKind> {
  [REFERENCE](): Reference & { readonly kind: K };
}

/**
 * Mark a value as referenceable without changing what it looks like: the
 * method is not enumerable, so the value still compares and serializes as
 * plain data.
 */
export function withReference<T extends object, K extends ReferenceKind>(
  value: T,
  reference: () => Reference & { readonly kind: K }
): T & Referenceable<K> {
  Object.defineProperty(value, REFERENCE, {
    enumerable: false,
    value: reference,
  });
  return value as T & Referenceable<K>;
}

export function isReferenceable(value: unknown): value is Referenceable {
  return (
    typeof value === "object" &&
    value !== null &&
    REFERENCE in value &&
    typeof (value as Referenceable)[REFERENCE] === "function"
  );
}

/**
 * One layer of what exists, by kind. `covers` says whether this source can
 * answer for a kind at all; `has` says whether a name of that kind exists.
 * A skill registry, an agent catalog, and a file checker are each one of
 * these. Generic over the kind so a consumer with more kinds can still
 * accept it.
 */
export interface ReferenceSource<K extends string = ReferenceKind> {
  covers(kind: K): boolean;
  has(kind: K, name: string): boolean;
}

/** Whether a name of one kind exists. */
export type NameLookup = (name: string) => boolean;

/**
 * A source from one predicate per kind. A kind with a predicate is covered
 * and answers through it; a kind left out, or set to `undefined`, is not
 * covered, so a consumer does not validate it. Predicates are read live on
 * every lookup, which is how a registry that changes between turns stays a
 * source.
 */
export function referenceSource<K extends string = ReferenceKind>(
  lookups: Partial<Record<K, NameLookup | undefined>>
): ReferenceSource<K> {
  const byKind = new Map<string, NameLookup>();
  const entries: [string, NameLookup | undefined][] = Object.entries(lookups);
  for (const [kind, lookup] of entries) {
    if (lookup !== undefined) {
      byKind.set(kind, lookup);
    }
  }
  return {
    covers: (kind) => byKind.has(kind),
    has: (kind, name) => byKind.get(kind)?.(name) ?? false,
  };
}
