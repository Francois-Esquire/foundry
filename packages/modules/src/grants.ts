import { digestJson } from "@foundry/lib/digest";

import type { ModuleVersion } from "./domain";
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
import type { InstallationGrant } from "./modules";

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
  const network = await networkRequest(manifest);
  if (network !== null) {
    requests.push(network);
  }
  return Object.freeze(requests);
}

export async function approvedNetworkDestinations(input: {
  readonly grants: readonly GrantFields[];
  readonly manifest: ModuleVersion["manifest"];
}): Promise<readonly NetworkDestination[] | null> {
  const network = await networkRequest(input.manifest);
  return network !== null && isGranted(input.grants, network)
    ? network.destinations
    : null;
}

export function grantMatches(grant: GrantFields, target: GrantTarget): boolean {
  return (
    target.constraintsDigest !== null &&
    grant.capability === target.capability &&
    grant.version === target.version &&
    grant.constraintsDigest === target.constraintsDigest
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

async function networkRequest(
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
