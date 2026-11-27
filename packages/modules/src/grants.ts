import {
  type AccessRequest,
  type Authorization,
  covers,
  type Grant,
  type Principal,
  type Scope,
} from "@foundry/authorization";
import { digestJson } from "@foundry/lib/digest";
import { byCodeUnit } from "@foundry/lib/ordering";

import type { InstallationId, ModuleVersion } from "./domain";
import type {
  ModuleCapabilityProvider,
  ModuleConstraintsPrincipal,
} from "./gateway/types";
import {
  capabilityIdentity,
  isStrictModuleManifest,
  type ModuleCapabilityRequest,
  type StrictModuleManifest,
} from "./manifest";
import type { InstallationGrant } from "./records";

export const MODULE_CAPABILITY_ACTION = "module.capability";

export const MODULE_INSTALLATION_PRINCIPAL_KIND = "module.installation";

export const MODULE_HOST_PRINCIPAL: Principal = Object.freeze({
  id: "host",
  kind: "module.host",
});

export const NETWORK_GRANT = Object.freeze({
  capability: "network",
  version: 1,
} as const);

export type NetworkDestination = NonNullable<
  StrictModuleManifest["network"]
>["destinations"][number];

export interface GrantTarget {
  readonly capability: string;
  readonly constraintsDigest: string | null;
  readonly version: number;
}

type GrantFields = Pick<
  InstallationGrant,
  "capability" | "constraintsDigest" | "version"
>;

export type ModuleCapabilityAccessRequest = {
  readonly capability: string;
  readonly kind: "capability";
  readonly reason: string;
  readonly request: ModuleCapabilityRequest;
  readonly required: boolean;
  readonly version: number;
} & (
  | { readonly availability: "available"; readonly constraintsDigest: string }
  | {
      readonly availability: "denied" | "unknown";
      readonly constraintsDigest: null;
    }
);

export interface ModuleNetworkAccessRequest {
  readonly availability: "available";
  readonly capability: typeof NETWORK_GRANT.capability;
  readonly constraintsDigest: string;
  readonly destinations: readonly NetworkDestination[];
  readonly kind: "network";
  readonly reason: string;
  readonly required: false;
  readonly version: typeof NETWORK_GRANT.version;
}

export type ModuleAccessRequest =
  | ModuleCapabilityAccessRequest
  | ModuleNetworkAccessRequest;

export function moduleInstallationPrincipal(
  installationId: InstallationId
): Principal {
  return {
    id: installationId,
    kind: MODULE_INSTALLATION_PRINCIPAL_KIND,
  };
}

export function moduleCapabilityScope(target: {
  readonly capability: string;
  readonly constraintsDigest: string;
  readonly version: number;
}): Scope {
  return {
    action: MODULE_CAPABILITY_ACTION,
    constraintsDigest: target.constraintsDigest,
    target: {
      kind: "exact",
      value: capabilityIdentity(target.capability, target.version),
    },
  };
}

export function moduleCapabilityAccessRequest(input: {
  readonly capability: string;
  readonly constraintsDigest: string;
  readonly installationId: InstallationId;
  readonly invocationId?: string;
  readonly version: number;
}): AccessRequest {
  return {
    action: MODULE_CAPABILITY_ACTION,
    constraintsDigest: input.constraintsDigest,
    ...(input.invocationId === undefined
      ? {}
      : { invocationId: input.invocationId }),
    principal: moduleInstallationPrincipal(input.installationId),
    target: capabilityIdentity(input.capability, input.version),
  };
}

export function grantToInstallationGrant(
  grant: Grant
): InstallationGrant | null {
  if (
    grant.scope.action !== MODULE_CAPABILITY_ACTION ||
    grant.scope.constraintsDigest === undefined ||
    grant.scope.target.kind !== "exact"
  ) {
    return null;
  }
  const separator = grant.scope.target.value.lastIndexOf("@");
  if (separator <= 0) {
    return null;
  }
  const capability = grant.scope.target.value.slice(0, separator);
  const version = Number(grant.scope.target.value.slice(separator + 1));
  if (!Number.isSafeInteger(version) || version <= 0) {
    return null;
  }
  return Object.freeze({
    capability,
    constraintsDigest: grant.scope.constraintsDigest,
    createdAt: new Date(grant.createdAt),
    version,
  });
}

export function installationGrantsFrom(
  grants: readonly Grant[]
): readonly InstallationGrant[] {
  return Object.freeze(
    grants
      .flatMap((grant) => {
        const projected = grantToInstallationGrant(grant);
        return projected === null ? [] : [projected];
      })
      .sort(byCodeUnit((grant) => grant.capability))
  );
}

export async function resolveCapabilityDigest(
  provider: ModuleCapabilityProvider,
  principal: ModuleConstraintsPrincipal,
  constraints: unknown
): Promise<string> {
  const { constraintsDigest } = await provider.resolveConstraints({
    principal,
    releaseConstraints: constraints ?? null,
  });
  if (
    typeof constraintsDigest !== "string" ||
    constraintsDigest.trim().length === 0
  ) {
    throw new Error("The provider resolved a blank constraints digest");
  }
  return constraintsDigest;
}

export async function moduleAccessRequests(input: {
  readonly version: Pick<ModuleVersion, "manifest">;
  readonly providers: readonly ModuleCapabilityProvider[];
  readonly principal: ModuleConstraintsPrincipal;
}): Promise<readonly ModuleAccessRequest[]> {
  const { manifest } = input.version;
  const providers = new Map(
    input.providers.map((provider) => [
      capabilityIdentity(
        provider.registration.descriptor.capability,
        provider.registration.descriptor.version
      ),
      provider,
    ])
  );
  const requests: ModuleAccessRequest[] = [];
  for (const request of manifest.capabilities) {
    const shared = {
      capability: request.capability,
      kind: "capability" as const,
      reason: request.reason,
      request,
      required: request.required,
      version: request.version,
    };
    const provider = providers.get(
      capabilityIdentity(request.capability, request.version)
    );
    if (provider === undefined) {
      requests.push({
        ...shared,
        availability: "unknown",
        constraintsDigest: null,
      });
      continue;
    }
    try {
      requests.push({
        ...shared,
        availability: "available",
        constraintsDigest: await resolveCapabilityDigest(
          provider,
          input.principal,
          request.constraints
        ),
      });
    } catch {
      requests.push({
        ...shared,
        availability: "denied",
        constraintsDigest: null,
      });
    }
  }
  const network = await networkAccessRequest(manifest);
  if (network !== null) {
    requests.push(network);
  }
  return Object.freeze(requests);
}

export async function networkAccessRequest(
  manifest: ModuleVersion["manifest"]
): Promise<ModuleNetworkAccessRequest | null> {
  if (!isStrictModuleManifest(manifest) || manifest.network === undefined) {
    return null;
  }
  const { destinations, reason } = manifest.network;
  return {
    ...NETWORK_GRANT,
    availability: "available",
    constraintsDigest: await digestJson(destinations),
    destinations,
    kind: "network",
    reason,
    required: false,
  };
}

export async function approvedNetworkDestinations(input: {
  readonly authorization?: Authorization;
  readonly grants?: readonly GrantFields[];
  readonly installationId?: InstallationId;
  readonly manifest: ModuleVersion["manifest"];
}): Promise<readonly NetworkDestination[] | null> {
  const network = await networkAccessRequest(input.manifest);
  if (network === null) {
    return null;
  }
  if (input.authorization !== undefined && input.installationId !== undefined) {
    const decision = await input.authorization.check(
      moduleCapabilityAccessRequest({
        capability: network.capability,
        constraintsDigest: network.constraintsDigest,
        installationId: input.installationId,
        version: network.version,
      })
    );
    return decision.kind === "allow" ? network.destinations : null;
  }
  return input.grants !== undefined && isGranted(input.grants, network)
    ? network.destinations
    : null;
}

const MATCH_PRINCIPAL: Principal = Object.freeze({
  id: "match",
  kind: MODULE_INSTALLATION_PRINCIPAL_KIND,
});

export function grantMatches(grant: GrantFields, target: GrantTarget): boolean {
  if (target.constraintsDigest === null) {
    return false;
  }
  return covers(
    moduleCapabilityScope(grant),
    {
      action: MODULE_CAPABILITY_ACTION,
      constraintsDigest: target.constraintsDigest,
      principal: MATCH_PRINCIPAL,
      target: capabilityIdentity(target.capability, target.version),
    },
    "allow"
  );
}

export function isGranted(
  grants: readonly GrantFields[],
  target: GrantTarget
): boolean {
  return grants.some((grant) => grantMatches(grant, target));
}

export function carriedGrants<Grant extends InstallationGrant>(
  grants: readonly Grant[],
  requests: readonly ModuleAccessRequest[]
): Grant[] {
  return grants.filter((grant) =>
    requests.some((request) => grantMatches(grant, request))
  );
}
