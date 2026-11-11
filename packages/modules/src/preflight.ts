import type { ModuleVersion } from "./domain";
import type {
  ModuleCapabilityProvider,
  ModuleConstraintsPrincipal,
} from "./gateway/types";
import { isGranted, moduleAccessRequests } from "./grants";
import {
  capabilityIdentity,
  isStrictModuleManifest,
  moduleSettingRequests,
} from "./manifest";
import type { ModuleSettingsHostPolicy, ModuleSettingValues } from "./settings";
import { resolveModuleSettings } from "./settings";
import type { InstallationGrant } from "./store/contract";

/** What the host's sandbox runtime can enforce for a released Program. */
export interface ModuleRuntimeSupport {
  /** A hard limit on private files. No current runtime enforces one. */
  readonly storageBytes: boolean;
}

/** Today's runtimes: lifecycle file checks are not a disk quota. */
export const MODULE_RUNTIME_SUPPORT: ModuleRuntimeSupport = Object.freeze({
  storageBytes: false,
});

export interface ActivationCompatibilityFact {
  /** A blocking fact stops the start; the rest disable one feature. */
  readonly blocking: boolean;
  readonly detail: string;
  readonly kind:
    | "unknown-capability"
    | "denied-capability"
    | "ungranted-capability"
    | "unsupported-requirement";
}

export interface CapabilityAddition {
  readonly alias: string;
  readonly capability: string;
  readonly constraints?: unknown;
  readonly required: boolean;
  readonly version: number;
}

export interface ActivationPreflight {
  /**
   * Requests the Installation's Grants do not cover yet: approval work. A
   * required one also blocks the start until it is approved.
   */
  readonly additions: readonly CapabilityAddition[];
  /** Whether nothing blocks the start. */
  readonly compatible: boolean;
  readonly facts: readonly ActivationCompatibilityFact[];
}

/**
 * Checks a Version before any sandbox is acquired: unsupported runtime and
 * resource requirements, settings the host cannot meet, and each requested
 * Capability against the host's providers and the Installation's Grants.
 * Grants match the digest the provider resolves from the raw requested
 * constraints, the same digest invocation admission compares. A required
 * Capability that is unavailable, denied or not yet approved blocks the
 * start; an optional one only disables that feature.
 */
export async function preflightModuleActivation(input: {
  readonly version: Pick<ModuleVersion, "manifest">;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly principal: ModuleConstraintsPrincipal;
  readonly grants: readonly InstallationGrant[];
  readonly runtime?: ModuleRuntimeSupport;
  readonly settings?: {
    readonly user?: ModuleSettingValues;
    readonly policy?: ModuleSettingsHostPolicy;
  };
}): Promise<ActivationPreflight> {
  const { manifest } = input.version;
  const facts: ActivationCompatibilityFact[] = [
    ...unsupportedModuleRequirements({
      manifest,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      ...(input.settings === undefined ? {} : { settings: input.settings }),
    }),
  ];
  const requests = await moduleAccessRequests({
    principal: input.principal,
    providers: input.providers,
    version: input.version,
  });
  const additions: CapabilityAddition[] = [];
  for (const request of requests) {
    if (request.kind !== "capability") {
      continue;
    }
    const key = capabilityIdentity(request.capability, request.version);
    if (request.availability === "unknown") {
      facts.push({
        blocking: request.required,
        detail: `Host does not provide ${key}`,
        kind: "unknown-capability",
      });
      continue;
    }
    if (request.availability === "denied") {
      facts.push({
        blocking: request.required,
        detail: `Host denies the constraints requested for ${key}`,
        kind: "denied-capability",
      });
      continue;
    }
    if (isGranted(input.grants, request)) {
      continue;
    }
    const { alias, constraints } = request.request;
    additions.push({
      alias,
      capability: request.capability,
      required: request.required,
      version: request.version,
      ...(constraints === undefined ? {} : { constraints }),
    });
    if (request.required) {
      facts.push({
        blocking: true,
        detail: `${key} (${alias}) is required and not approved`,
        kind: "ungranted-capability",
      });
    }
  }
  return Object.freeze({
    additions: Object.freeze(additions),
    compatible: !facts.some((fact) => fact.blocking),
    facts: Object.freeze(facts),
  });
}

/**
 * Runtime and resource requirements this host cannot meet for `manifest`,
 * each blocking: checked when a release is built and again before it starts.
 */
export function unsupportedModuleRequirements(input: {
  readonly manifest: ModuleVersion["manifest"];
  readonly runtime?: ModuleRuntimeSupport;
  readonly settings?: {
    readonly user?: ModuleSettingValues;
    readonly policy?: ModuleSettingsHostPolicy;
  };
}): ActivationCompatibilityFact[] {
  const { manifest } = input;
  const runtime = input.runtime ?? MODULE_RUNTIME_SUPPORT;
  const facts: ActivationCompatibilityFact[] = [];
  if (
    isStrictModuleManifest(manifest) &&
    manifest.resources?.storageBytes !== undefined &&
    !runtime.storageBytes
  ) {
    facts.push({
      blocking: true,
      detail:
        "The Module requires a hard storage limit (resources.storageBytes), which this host's sandbox cannot enforce",
      kind: "unsupported-requirement",
    });
  }
  const settings = resolveModuleSettings({
    requests: moduleSettingRequests(manifest),
    ...(input.settings?.user === undefined
      ? {}
      : { user: input.settings.user }),
    ...(input.settings?.policy === undefined
      ? {}
      : { policy: input.settings.policy }),
  });
  if (!settings.ok) {
    for (const problem of settings.problems) {
      facts.push({
        blocking: true,
        detail: problem.message,
        kind: "unsupported-requirement",
      });
    }
  }
  return facts;
}
