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
import type { InstallationGrant } from "./store/contract";

/**
 * The Grant a strict Manifest's `network` request asks for. Capability names
 * are dotted (`CAPABILITY_NAME_PATTERN`), so this one cannot collide with a
 * Gateway Capability. Its digest covers the requested destinations, so a
 * changed destination list asks again.
 */
export const NETWORK_GRANT = Object.freeze({
  capability: "network",
  version: 1,
} as const);

export type NetworkDestination = NonNullable<
  StrictModuleManifest["network"]
>["destinations"][number];

/** What a Grant has to match: a capability, its version and a resolved digest. */
export interface GrantTarget {
  readonly capability: string;
  /** `null` while unavailable: nothing matches it. */
  readonly constraintsDigest: string | null;
  readonly version: number;
}

type GrantFields = Pick<
  InstallationGrant,
  "capability" | "constraintsDigest" | "version"
>;

/** A Capability request of the Version, resolved against the host's provider. */
export type ModuleCapabilityAccessRequest = {
  /** `request.capability`, here so every request is matched the same way. */
  readonly capability: string;
  readonly kind: "capability";
  readonly reason: string;
  /** The Manifest's request: its alias and raw constraints. */
  readonly request: ModuleCapabilityRequest;
  readonly required: boolean;
  readonly version: number;
} & (
  | { readonly availability: "available"; readonly constraintsDigest: string }
  | {
      /** `unknown`: no provider; `denied`: the provider refuses the constraints. */
      readonly availability: "denied" | "unknown";
      readonly constraintsDigest: null;
    }
);

/** The Version's released-app network request: its destinations, by digest. */
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

/**
 * One thing a Version asks the user to approve, resolved against the host:
 * a Gateway Capability, or released-app network access.
 */
export type ModuleAccessRequest =
  | ModuleCapabilityAccessRequest
  | ModuleNetworkAccessRequest;

/**
 * The digest a Grant for `constraints` must carry: the provider's, for the
 * raw requested constraints. Invocation admission and Access both resolve
 * it here. Throws when the provider refuses them or answers a blank digest.
 */
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

/**
 * Every request of a Version, resolved the way invocation admission resolves
 * it: Capability Grants match the digest the provider returns for the raw
 * requested constraints; the network Grant matches the digest of the
 * normalized destination list.
 */
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

/**
 * The destinations a released Program may reach: the selected Version's
 * requested destinations when the Installation holds a network Grant for
 * exactly that list, otherwise `null` (no network). The Grant records only a
 * digest, so a changed declaration matches nothing and asks again in Access.
 */
export async function approvedNetworkDestinations(input: {
  readonly grants: readonly GrantFields[];
  readonly manifest: ModuleVersion["manifest"];
}): Promise<readonly NetworkDestination[] | null> {
  const network = await networkRequest(input.manifest);
  return network !== null && isGranted(input.grants, network)
    ? network.destinations
    : null;
}

/** Whether `grant` approves `target` as it stands. */
export function grantMatches(grant: GrantFields, target: GrantTarget): boolean {
  return (
    target.constraintsDigest !== null &&
    grant.capability === target.capability &&
    grant.version === target.version &&
    grant.constraintsDigest === target.constraintsDigest
  );
}

/** Whether any of `grants` approves `target`. */
export function isGranted(
  grants: readonly GrantFields[],
  target: GrantTarget
): boolean {
  return grants.some((grant) => grantMatches(grant, target));
}

/**
 * The Grants that carry over to a Version with these requests: those whose
 * capability, capability version and resolved constraints digest are
 * unchanged. The rest are dropped, so a changed request asks again.
 */
export function carriedGrants<Grant extends InstallationGrant>(
  grants: readonly Grant[],
  requests: readonly ModuleAccessRequest[]
): Grant[] {
  return grants.filter((grant) =>
    requests.some((request) => grantMatches(grant, request))
  );
}

/** A strict Manifest's `network` request, with the digest its Grant carries. */
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
