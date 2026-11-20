import type { AuthorizationAddress, AuthorizationSubject } from "./address";

export type GrantLifetime =
  | { readonly kind: "once" }
  | { readonly kind: "session"; readonly scopeId: string }
  | { readonly kind: "persistent" };

export type GrantProvenance = "human" | "profile" | "certificate" | "system";

export interface Grant<S extends AuthorizationSubject, C> {
  readonly address: AuthorizationAddress<S>;
  readonly capability: C;
  readonly certificateId?: string;
  readonly expiresAt?: number;
  readonly id: string;
  readonly issuanceKey?: string;
  readonly issuedAt: number;
  readonly lifetime: GrantLifetime;
  readonly provenance: GrantProvenance;
  readonly revision: number;
}

export interface GrantInput<S extends AuthorizationSubject, C> {
  readonly address: AuthorizationAddress<S>;
  readonly capability: C;
  readonly certificateId?: string;
  readonly expiresAt?: number;
  readonly issuanceKey?: string;
  readonly lifetime: GrantLifetime;
  readonly provenance: GrantProvenance;
}

export interface GrantClaim {
  readonly grantId: string;
  readonly invocationId: string;
  readonly revision: number;
}

export class GrantClaimError extends Error {
  readonly grantId: string;

  constructor(grantId: string, reason: string) {
    super(reason);
    this.name = "GrantClaimError";
    this.grantId = grantId;
  }
}

export class GrantRevisionError extends Error {
  readonly grantId: string;
  readonly expected: number;
  readonly actual: number;

  constructor(grantId: string, expected: number, actual: number) {
    super(
      `Grant ${grantId} is at revision ${String(actual)}, not ${String(expected)}.`
    );
    this.name = "GrantRevisionError";
    this.grantId = grantId;
    this.expected = expected;
    this.actual = actual;
  }
}

export interface GrantRepository<S extends AuthorizationSubject, C> {
  claimOnce: (grantId: string, invocationId: string) => Promise<GrantClaim>;
  find: (
    address: AuthorizationAddress<S>,
    now: number
  ) => Promise<readonly Grant<S, C>[]>;
  issue: (input: GrantInput<S, C>) => Promise<Grant<S, C>>;
  revoke: (grantId: string, expectedRevision?: number) => Promise<void>;
  revokeIssuance: (issuanceKey: string) => Promise<void>;
}
