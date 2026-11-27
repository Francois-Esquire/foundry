import type { Authorization } from "@foundry/authorization";
import type { ModuleVersion } from "./domain";
import type {
  ModuleCapabilityProvider,
  ModuleConstraintsPrincipal,
} from "./gateway/types";
import {
  isGranted,
  moduleAccessRequests,
  moduleCapabilityAccessRequest,
} from "./grants";
import {
  capabilityIdentity,
  isStrictModuleManifest,
  moduleSettingRequests,
} from "./manifest";
import type { InstallationGrant } from "./modules";
import type { ModuleSettingsHostPolicy, ModuleSettingValues } from "./settings";
import { resolveModuleSettings } from "./settings";

export interface ModuleRuntimeSupport {
  readonly storageBytes: boolean;
}

export const MODULE_RUNTIME_SUPPORT: ModuleRuntimeSupport = Object.freeze({
  storageBytes: false,
});

export interface ActivationCompatibilityFact {
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
  readonly additions: readonly CapabilityAddition[];
  readonly compatible: boolean;
  readonly facts: readonly ActivationCompatibilityFact[];
}

export async function preflightModuleActivation(input: {
  readonly authorization?: Authorization;
  readonly version: Pick<ModuleVersion, "manifest">;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly principal: ModuleConstraintsPrincipal;
  readonly grants?: readonly InstallationGrant[];
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
    const evaluated = await evaluateCapabilityRequest(request, input);
    if (evaluated.addition !== undefined) {
      additions.push(evaluated.addition);
    }
    if (evaluated.fact !== undefined) {
      facts.push(evaluated.fact);
    }
  }
  return Object.freeze({
    additions: Object.freeze(additions),
    compatible: !facts.some((fact) => fact.blocking),
    facts: Object.freeze(facts),
  });
}

async function evaluateCapabilityRequest(
  request: Extract<
    Awaited<ReturnType<typeof moduleAccessRequests>>[number],
    { readonly kind: "capability" }
  >,
  input: {
    readonly authorization?: Authorization;
    readonly grants?: readonly InstallationGrant[];
    readonly principal: ModuleConstraintsPrincipal;
  }
): Promise<{
  readonly addition?: CapabilityAddition;
  readonly fact?: ActivationCompatibilityFact;
}> {
  const key = capabilityIdentity(request.capability, request.version);
  if (request.availability === "unknown") {
    return {
      fact: {
        blocking: request.required,
        detail: `Host does not provide ${key}`,
        kind: "unknown-capability",
      },
    };
  }
  if (request.availability === "denied") {
    return {
      fact: {
        blocking: request.required,
        detail: `Host denies the constraints requested for ${key}`,
        kind: "denied-capability",
      },
    };
  }
  if (input.authorization !== undefined && request.constraintsDigest !== null) {
    const decision = await input.authorization.check(
      moduleCapabilityAccessRequest({
        capability: request.capability,
        constraintsDigest: request.constraintsDigest,
        installationId: input.principal.installationId,
        version: request.version,
      })
    );
    if (decision.kind === "allow") {
      return {};
    }
    if (decision.kind === "deny") {
      return {
        fact: {
          blocking: request.required,
          detail: `Host denies ${key}: ${decision.reason}`,
          kind: "denied-capability",
        },
      };
    }
  } else if (input.grants !== undefined && isGranted(input.grants, request)) {
    return {};
  }
  const { alias, constraints } = request.request;
  return {
    addition: {
      alias,
      capability: request.capability,
      required: request.required,
      version: request.version,
      ...(constraints === undefined ? {} : { constraints }),
    },
    ...(request.required
      ? {
          fact: {
            blocking: true,
            detail: `${key} (${alias}) is required and not approved`,
            kind: "ungranted-capability" as const,
          },
        }
      : {}),
  };
}

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
