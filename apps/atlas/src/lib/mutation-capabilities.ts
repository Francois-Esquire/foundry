import { createHash } from "node:crypto";

import type { PlannedTransformationKind } from "./operator-plan-types";

// V11.4 mutation capability registry: which planned transformation kinds and
// syntax forms a mutator can execute today, atomically and reversibly. Data
// only; nothing here mutates. The default mirrors the legacy internalize
// path (export narrowing, re-export and import rewrites) and nothing more.
// Widening it is a V12 decision, taken by adding mutator support first.

/** Bumps when the default registry's support changes. */
const MUTATION_CAPABILITY_VERSION = 1;

interface MutationCapability {
  /** The edit lands in one write per file with no intermediate state. */
  atomic: boolean;
  /** The edit is undone by restoring the pre-mutation bytes. */
  reversible: boolean;
  /** Syntax forms (`PlannedTransformation.form`) the mutator handles; `*` for form-independent kinds. */
  supportedForms: string[];
  transformationKind: PlannedTransformationKind;
}

export interface MutationCapabilityRegistry {
  capabilities: MutationCapability[];
  version: number;
}

export const DEFAULT_MUTATION_CAPABILITIES: MutationCapabilityRegistry = {
  capabilities: [
    {
      atomic: true,
      reversible: true,
      supportedForms: ["named-export"],
      transformationKind: "remove-export",
    },
    {
      atomic: true,
      reversible: true,
      supportedForms: ["named-reexport", "type-reexport"],
      transformationKind: "rewrite-reexport",
    },
    {
      atomic: true,
      reversible: true,
      supportedForms: [
        "named-import",
        "named-import-relative",
        "type-import",
        "type-import-relative",
      ],
      transformationKind: "rewrite-import",
    },
    {
      atomic: true,
      reversible: true,
      supportedForms: [
        "named-import",
        "named-import-relative",
        "type-import",
        "type-import-relative",
      ],
      transformationKind: "update-test-import",
    },
    {
      atomic: true,
      reversible: true,
      supportedForms: ["compat-at-route"],
      transformationKind: "preserve-compatibility-export",
    },
    {
      atomic: true,
      reversible: true,
      supportedForms: ["*"],
      transformationKind: "verify-only",
    },
  ],
  version: MUTATION_CAPABILITY_VERSION,
};

export interface CapabilityLookup {
  atomic: boolean;
  /** Why not, when unsupported. */
  reason?: string;
  reversible: boolean;
  supported: boolean;
}

export function lookupCapability(
  registry: MutationCapabilityRegistry,
  kind: PlannedTransformationKind,
  form: string | undefined
): CapabilityLookup {
  const capability = registry.capabilities.find(
    (c) => c.transformationKind === kind
  );
  if (capability === undefined) {
    return {
      atomic: false,
      reason: `no mutator handles ${kind}`,
      reversible: false,
      supported: false,
    };
  }
  if (
    capability.supportedForms.includes("*") ||
    (form !== undefined && capability.supportedForms.includes(form))
  ) {
    return {
      atomic: capability.atomic,
      reversible: capability.reversible,
      supported: true,
    };
  }
  return {
    atomic: capability.atomic,
    reason:
      form === undefined
        ? `${kind} has no recorded syntax form`
        : `${kind} does not handle the ${form} form`,
    reversible: capability.reversible,
    supported: false,
  };
}

/** Stable over the registry contents, independent of capability order. */
export function capabilityFingerprint(
  registry: MutationCapabilityRegistry
): string {
  const rows = registry.capabilities
    .map(
      (c) =>
        `${c.transformationKind}:${[...c.supportedForms].sort((a, b) => a.localeCompare(b)).join("|")}:${c.atomic ? "atomic" : "non-atomic"}:${c.reversible ? "reversible" : "irreversible"}`
    )
    .sort((a, b) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify([registry.version, rows]))
    .digest("hex")
    .slice(0, 16);
}
