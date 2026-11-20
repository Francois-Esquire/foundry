import { createHash } from "node:crypto";

import type { PlannedTransformationKind } from "./operator-plan-types";

const MUTATION_CAPABILITY_VERSION = 3;

interface MutationCapability {
  atomic: boolean;
  reversible: boolean;
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
      supportedForms: ["*"],
      transformationKind: "verify-only",
    },
  ],
  version: MUTATION_CAPABILITY_VERSION,
};

export interface CapabilityLookup {
  atomic: boolean;
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
