import type { CommitEffects } from "@foundry/core/storage";
import type { Principal, PrincipalMatcher, Scope } from "./scope";

export type GrantId = string & { readonly __brand: "GrantId" };

export type RestrictionId = string & { readonly __brand: "RestrictionId" };

export const GRANT_STATES = [
  "pending",
  "active",
  "denied",
  "revoked",
  "exhausted",
] as const;

export type GrantState = (typeof GRANT_STATES)[number];

export const RESTRICTION_KINDS = ["deny", "require-direct-grant"] as const;

export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export interface GrantApproval {
  readonly approver: Principal;
  readonly at: number;
  readonly parentGrantId?: GrantId;
  readonly reason?: string;
}

export interface GrantDenial {
  readonly approver: Principal;
  readonly at: number;
  readonly reason: string;
}

export interface Grant {
  readonly approvals: readonly GrantApproval[];
  readonly canDelegate: boolean;
  readonly createdAt: number;
  readonly deniedBy?: GrantDenial;
  readonly expiresAt?: number;
  readonly holder: PrincipalMatcher;
  readonly id: GrantId;
  readonly invocationId?: string;
  readonly issuanceKey?: string;
  readonly parentIds: readonly GrantId[];
  readonly reason?: string;
  readonly requestedBy: Principal;
  readonly requiredApprovals: number;
  readonly revision: number;
  readonly revokedAt?: number;
  readonly revokedReason?: string;
  readonly scope: Scope;
  readonly sessionId?: string;
  readonly state: GrantState;
  readonly updatedAt: number;
  readonly usesRemaining?: number;
}

export interface Restriction {
  readonly appliesUnder?: GrantId;
  readonly createdAt: number;
  readonly holder?: PrincipalMatcher;
  readonly id: RestrictionId;
  readonly kind: RestrictionKind;
  readonly reason: string;
  readonly revision: number;
  readonly scope: Scope;
  readonly updatedAt: number;
}

export interface InvocationClaim {
  readonly claimedAt: number;
  readonly grantId: GrantId;
  readonly invocationId: string;
}

export interface AuthorizationReceipt {
  readonly grantId: GrantId;
  readonly grantPath: readonly GrantId[];
  readonly invocationId: string;
  readonly issuedAt: number;
}

export type Decision =
  | {
      readonly grantId: GrantId;
      readonly grantPath: readonly GrantId[];
      readonly kind: "allow";
    }
  | {
      readonly kind: "ask";
      readonly reason: string;
      readonly restrictionId?: RestrictionId;
    }
  | {
      readonly kind: "deny";
      readonly reason: string;
      readonly restrictionId?: RestrictionId;
    };

export type RevocationTarget =
  | {
      readonly expectedRevision?: number;
      readonly grantId: GrantId;
      readonly kind: "grant";
    }
  | {
      readonly kind: "principal";
      readonly principal: Pick<Principal, "kind" | "id" | "version">;
    }
  | { readonly issuanceKey: string; readonly kind: "issuance" }
  | { readonly kind: "session"; readonly sessionId: string };

export type AuthorizationEvent =
  | {
      readonly at: number;
      readonly grant: Grant;
      readonly type: "grant.requested";
    }
  | {
      readonly at: number;
      readonly grant: Grant;
      readonly type: "grant.issued";
    }
  | {
      readonly approval: GrantApproval;
      readonly at: number;
      readonly grant: Grant;
      readonly type: "grant.approved";
    }
  | {
      readonly at: number;
      readonly grant: Grant;
      readonly type: "grant.denied";
    }
  | {
      readonly at: number;
      readonly grantIds: readonly GrantId[];
      readonly reason?: string;
      readonly type: "grant.revoked";
    }
  | {
      readonly at: number;
      readonly grantId: GrantId;
      readonly invocationId: string;
      readonly type: "grant.consumed";
      readonly usesRemaining?: number;
    }
  | {
      readonly at: number;
      readonly restriction: Restriction;
      readonly type: "restriction.added";
    }
  | {
      readonly at: number;
      readonly restrictionId: RestrictionId;
      readonly type: "restriction.lifted";
    };

export interface GrantQuery {
  readonly action?: string;
  readonly invocationId?: string;
  readonly issuanceKey?: string;
  readonly parentId?: GrantId;
  readonly principal?: Principal;
  readonly sessionId?: string;
  readonly state?: GrantState | readonly GrantState[];
}

export interface AuthorizeOptions {
  readonly effects?: CommitEffects;
  readonly idempotent?: boolean;
  readonly openPending?: boolean;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export interface RequestGrantInput {
  readonly canDelegate?: boolean;
  readonly effects?: CommitEffects;
  readonly expiresAt?: number;
  readonly holder: PrincipalMatcher;
  readonly id?: GrantId;
  readonly invocationId?: string;
  readonly issuanceKey?: string;
  readonly reason?: string;
  readonly requestedBy: Principal;
  readonly requiredApprovals?: number;
  readonly scope: Scope;
  readonly sessionId?: string;
  readonly usesRemaining?: number;
}

export interface IssueGrantInput {
  readonly canDelegate?: boolean;
  readonly effects?: CommitEffects;
  readonly expiresAt?: number;
  readonly holder: PrincipalMatcher;
  readonly id?: GrantId;
  readonly issuanceKey?: string;
  readonly issuer?: Principal;
  readonly parentIds?: readonly GrantId[];
  readonly reason?: string;
  readonly requestedBy: Principal;
  readonly scope: Scope;
  readonly sessionId?: string;
  readonly usesRemaining?: number;
}

export interface ApproveGrantInput {
  readonly allowSelfApproval?: boolean;
  readonly approver: Principal;
  readonly canDelegate?: boolean;
  readonly effects?: CommitEffects;
  readonly expiresAt?: number;
  readonly parentGrantId?: GrantId;
  readonly reason?: string;
  readonly rootAuthority?: boolean;
  readonly scope?: Scope;
  readonly sessionId?: string;
  readonly usesRemaining?: number;
}

export interface DenyGrantInput {
  readonly approver: Principal;
  readonly effects?: CommitEffects;
  readonly reason: string;
}

export interface AddRestrictionInput {
  readonly appliesUnder?: GrantId;
  readonly effects?: CommitEffects;
  readonly holder?: PrincipalMatcher;
  readonly id?: RestrictionId;
  readonly kind: RestrictionKind;
  readonly reason: string;
  readonly scope: Scope;
}

export interface RevokeOptions {
  readonly effects?: CommitEffects;
  readonly reason?: string;
}

export interface LiftRestrictionOptions {
  readonly effects?: CommitEffects;
}

export function grantId(value: string): GrantId {
  return value as GrantId;
}

export function restrictionId(value: string): RestrictionId {
  return value as RestrictionId;
}
