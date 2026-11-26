import type { AuthorizationSubject } from "./address";
import type { Grant, GrantClaim, GrantInput } from "./grant";
import { GrantClaimError, GrantRevisionError } from "./grant";

export interface GrantEntry<S extends AuthorizationSubject, C> {
  readonly claim?: GrantClaim;
  readonly grant: Grant<S, C>;
  readonly revoked: boolean;
}

export function grantIdFor(sequence: number): string {
  return `grant_${String(sequence)}`;
}

export function issuedGrant<S extends AuthorizationSubject, C>(
  input: GrantInput<S, C>,
  id: string,
  issuedAt: number
): Grant<S, C> {
  return {
    address: input.address,
    capability: input.capability,
    id,
    issuedAt,
    lifetime: input.lifetime,
    provenance: input.provenance,
    revision: 1,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.certificateId === undefined
      ? {}
      : { certificateId: input.certificateId }),
    ...(input.issuanceKey === undefined
      ? {}
      : { issuanceKey: input.issuanceKey }),
  };
}

export function isLiveGrant<S extends AuthorizationSubject, C>(
  entry: GrantEntry<S, C>,
  at: number
): boolean {
  if (entry.revoked) {
    return false;
  }
  const { expiresAt } = entry.grant;
  return expiresAt === undefined || expiresAt > at;
}

export function claimGrant<S extends AuthorizationSubject, C>(
  entry: GrantEntry<S, C> | undefined,
  grantId: string,
  invocationId: string,
  at: number
): { readonly claim: GrantClaim; readonly next?: GrantEntry<S, C> } {
  if (!entry) {
    throw new GrantClaimError(grantId, `Grant ${grantId} does not exist.`);
  }

  if (entry.claim) {
    if (entry.claim.invocationId === invocationId) {
      return { claim: entry.claim };
    }
    throw new GrantClaimError(
      grantId,
      `Grant ${grantId} is one-shot and was already claimed by another invocation.`
    );
  }

  if (!isLiveGrant(entry, at)) {
    throw new GrantClaimError(
      grantId,
      `Grant ${grantId} is revoked or expired.`
    );
  }

  if (entry.grant.lifetime.kind !== "once") {
    return {
      claim: { grantId, invocationId, revision: entry.grant.revision },
    };
  }

  const revision = entry.grant.revision + 1;
  const claim = { grantId, invocationId, revision };
  return {
    claim,
    next: { claim, grant: { ...entry.grant, revision }, revoked: true },
  };
}

export function revokeGrant<S extends AuthorizationSubject, C>(
  entry: GrantEntry<S, C> | undefined,
  grantId: string,
  expectedRevision?: number
): GrantEntry<S, C> | undefined {
  if (!entry) {
    return;
  }

  if (
    expectedRevision !== undefined &&
    expectedRevision !== entry.grant.revision
  ) {
    throw new GrantRevisionError(
      grantId,
      expectedRevision,
      entry.grant.revision
    );
  }

  if (entry.revoked) {
    return;
  }

  return {
    ...entry,
    grant: { ...entry.grant, revision: entry.grant.revision + 1 },
    revoked: true,
  };
}
