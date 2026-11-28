import type { ReferenceSource } from "@foundry/core/agents";
import { type NameLookup, referenceSource } from "@foundry/core/agents";
import type { PromptReferenceKind } from "./reference";

export type Membership = Iterable<string> | NameLookup;

export type PromptNames = Partial<Record<PromptReferenceKind, Membership>>;

export function isSource(
  value: PromptSource | PromptNames
): value is PromptSource {
  return typeof (value as PromptSource).has === "function";
}

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

export function layered(layers: readonly PromptSource[]): PromptSource {
  return {
    covers: (kind) => layers.some((layer) => layer.covers(kind)),
    has: (kind, name) => layers.some((layer) => layer.has(kind, name)),
  };
}

export type PromptSource = ReferenceSource<PromptReferenceKind>;
