export type ReferenceKind = "agent" | "file" | "mcp" | "skill";

export type Reference =
  | { readonly kind: "agent"; readonly name: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "mcp"; readonly name: string }
  | { readonly kind: "skill"; readonly name: string };

export const REFERENCE: unique symbol = Symbol.for("@foundry/reference");

export interface Referenceable<K extends ReferenceKind = ReferenceKind> {
  [REFERENCE](): Reference & { readonly kind: K };
}

export function withReference<T extends object, K extends ReferenceKind>(
  value: T,
  reference: () => Reference & { readonly kind: K }
): T & Referenceable<K> {
  if (!Object.isExtensible(value)) {
    throw new Error(
      "withReference needs an extensible value; a frozen, sealed, or non-extensible value cannot carry a reference."
    );
  }
  Object.defineProperty(value, REFERENCE, {
    configurable: true,
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

export interface ReferenceSource<K extends string = ReferenceKind> {
  covers(kind: K): boolean;
  has(kind: K, name: string): boolean;
}

export type NameLookup = (name: string) => boolean;

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
