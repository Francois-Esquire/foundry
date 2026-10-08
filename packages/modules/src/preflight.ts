import { digestJson } from "@foundry/lib/digest";

import type { ModuleVersion } from "./domain";
import type { InstallationGrant } from "./store/contract";

export interface CapabilityCatalogEntry {
  readonly capability: string;
  readonly version: number;
}

export interface ActivationCompatibilityFact {
  readonly detail: string;
  readonly kind: "unknown-capability";
}

export interface CapabilityAddition {
  readonly alias: string;
  readonly capability: string;
  readonly constraints?: unknown;
  readonly required: boolean;
  readonly version: number;
}

export interface ActivationPreflight {
  readonly additions: readonly CapabilityAddition[];
  readonly compatible: boolean;
  readonly facts: readonly ActivationCompatibilityFact[];
}

export async function preflightModuleActivation(input: {
  readonly version: Pick<ModuleVersion, "manifest">;
  readonly capabilities: readonly CapabilityCatalogEntry[];
  readonly grants: readonly InstallationGrant[];
}): Promise<ActivationPreflight> {
  const facts: ActivationCompatibilityFact[] = [];
  const { manifest } = input.version;
  const known = new Set(
    input.capabilities.map((entry) => `${entry.capability}@${entry.version}`)
  );
  const grants = new Set(
    input.grants.map(
      (grant) =>
        `${grant.capability}@${grant.version}:${grant.constraintsDigest}`
    )
  );
  const additions: CapabilityAddition[] = [];
  for (const request of manifest.capabilities) {
    const key = `${request.capability}@${request.version}`;
    if (!known.has(key)) {
      facts.push({
        detail: `Host does not provide ${key}`,
        kind: "unknown-capability",
      });
      continue;
    }
    const constraintsDigest = await digestJson(request.constraints ?? null);
    if (!grants.has(`${key}:${constraintsDigest}`)) {
      additions.push({
        alias: request.alias,
        capability: request.capability,
        required: request.required,
        version: request.version,
        ...(request.constraints === undefined
          ? {}
          : { constraints: request.constraints }),
      });
    }
  }
  return Object.freeze({
    additions: Object.freeze(additions),
    compatible: facts.length === 0,
    facts: Object.freeze(facts),
  });
}
