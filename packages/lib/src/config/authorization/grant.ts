/**
 * Affirmative authority, and the repository that holds it.
 *
 * A Grant says yes. It never says no. A denial is a Policy rule or an Approval
 * outcome — giving a Grant a negative form is what previously let one noun mean
 * both "authority" and "the answer a human gave", after which neither could be
 * reasoned about. Likewise lifetime and provenance are separate fields here:
 * the module implementation folded them into one `GrantScope` union whose
 * `"policy-provided"` member described *where a grant came from* while its
 * siblings described *how long it lasts*.
 */

import type { AuthorizationAddress, AuthorizationSubject } from "./address";

/**
 * How long authority lasts.
 *
 * `session` carries the host-issued scope it is valid within rather than
 * leaving "which session?" to be inferred later — an unqualified session grant
 * is indistinguishable from a persistent one at lookup time, which is how
 * session authority leaks across sessions.
 */
export type GrantLifetime =
  | { readonly kind: "once" }
  | { readonly kind: "session"; readonly scopeId: string }
  | { readonly kind: "persistent" };

/**
 * Where authority came from. Runtime effect is identical; the distinction
 * matters for revocation (revoking a Certificate must not remove a human's own
 * decision) and for explaining to a user why something was allowed.
 */
export type GrantProvenance = "human" | "profile" | "certificate" | "system";

/**
 * One Subject's authority to exercise one Capability.
 *
 * Carries both the structured `address` used for equality and the host
 * `capability` used for evaluation and explanation. Keeping both means a
 * repository never has to reconstruct a capability from an opaque key.
 */
export interface Grant<S extends AuthorizationSubject, C> {
  readonly address: AuthorizationAddress<S>;
  readonly capability: C;
  readonly certificateId?: string;
  readonly expiresAt?: number;
  readonly id: string;
  readonly issuedAt: number;
  readonly lifetime: GrantLifetime;
  readonly provenance: GrantProvenance;
  /**
   * Bumped on every state change to this Grant — claim or revoke.
   *
   * Optimistic-concurrency token: a caller holding a Grant read earlier can
   * pass it to {@link GrantRepository.revoke} and be rejected if authority
   * moved underneath it. This is per-Grant rather than the module store's
   * per-key counter because an address may now hold several live Grants (one
   * per contributing Certificate), so a shared counter would make revoking one
   * of them fail merely because another was issued.
   */
  readonly revision: number;
}

export interface GrantInput<S extends AuthorizationSubject, C> {
  readonly address: AuthorizationAddress<S>;
  readonly capability: C;
  readonly certificateId?: string;
  readonly expiresAt?: number;
  readonly lifetime: GrantLifetime;
  readonly provenance: GrantProvenance;
}

/** Proof that one invocation consumed (or was cleared against) one Grant. */
export interface GrantClaim {
  readonly grantId: string;
  readonly invocationId: string;
  readonly revision: number;
}

/**
 * Thrown when a Grant cannot back the invocation presenting it — absent,
 * revoked, expired, or a one-shot already spent by a different invocation.
 *
 * A distinct type so the Authorizer can turn a lost race into a denial instead
 * of letting an unrelated bug surface as one.
 */
export class GrantClaimError extends Error {
  readonly grantId: string;

  constructor(grantId: string, reason: string) {
    super(reason);
    this.name = "GrantClaimError";
    this.grantId = grantId;
  }
}

/** Thrown when a revoke presents a revision that is no longer current. */
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

/**
 * Mutable current authority. A repository, not a ledger: it answers "what is
 * true now", and `find` is a lookup rather than a fold over history. Append-only
 * history is a separate concern — see `events.ts`.
 *
 * Asynchronous at the canonical interface even though the reference adapter is
 * a map, so that adopting a durable store later is not a contract change and
 * the Capability Kernel never acquires a second synchronous authority surface.
 */
export interface GrantRepository<S extends AuthorizationSubject, C> {
  /**
   * Claim this Grant for one invocation, at the effect boundary.
   *
   * Atomic and idempotent by `invocationId`: replaying the same invocation
   * observes its existing claim, while a different invocation cannot consume
   * the same one-shot authority. Grants that are not one-shot are not consumed
   * — the call still returns a claim, so the effect boundary has one code path.
   *
   * Throws {@link GrantClaimError} when the Grant cannot back this invocation.
   */
  claimOnce: (grantId: string, invocationId: string) => Promise<GrantClaim>;
  /** Live Grants at this address as of `now` — absent, revoked, and expired authority is filtered out. */
  find: (
    address: AuthorizationAddress<S>,
    now: number
  ) => Promise<readonly Grant<S, C>[]>;
  issue: (input: GrantInput<S, C>) => Promise<Grant<S, C>>;
  /**
   * Idempotent without an expectation: revoking authority that is already gone
   * succeeds, because that is the state the caller wanted.
   *
   * Supplying `expectedRevision` asserts the Grant is still where the caller
   * last read it. Anything that moved it since — a claim, another revoke —
   * throws {@link GrantRevisionError} rather than reporting a success the
   * caller did not cause.
   */
  revoke: (grantId: string, expectedRevision?: number) => Promise<void>;
}
