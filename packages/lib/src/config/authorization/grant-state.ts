/**
 * What every {@link GrantRepository} adapter does to one Grant, as pure
 * functions over its stored state.
 *
 * The in-memory reference adapter and the file adapter both apply these, so a
 * durable store cannot drift from the reference semantics: issue numbering,
 * liveness, the replay-before-liveness order of a claim, and the
 * revision-before-idempotence order of a revoke all live here once. Adapters
 * own only where entries are kept and how they are found.
 *
 * Pure and renderer-safe. Kept off the barrel because it is adapter plumbing,
 * not host vocabulary. The package's `./config/*` export still reaches it as
 * `@foundry/lib/config/authorization/grant-state`: that path is public for
 * writing another GrantRepository adapter, but less stable than the barrel.
 * It follows the adapters' needs, and hosts should not build on it.
 */

import type { AuthorizationSubject } from "./address";
import type { Grant, GrantClaim, GrantInput } from "./grant";
import { GrantClaimError, GrantRevisionError } from "./grant";

/** One Grant as a repository holds it. */
export interface GrantEntry<S extends AuthorizationSubject, C> {
  /** The claim that consumed this Grant, if it was one-shot and has been taken. */
  readonly claim?: GrantClaim;
  readonly grant: Grant<S, C>;
  readonly revoked: boolean;
}

/** Ids are issue order, starting at 1, so they are unique per repository and never reused. */
export function grantIdFor(sequence: number): string {
  return `grant_${String(sequence)}`;
}

/** The record `issue` stores and returns: revision 1, absent optionals omitted. */
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
  };
}

/** Not revoked, and not past its expiry (the expiry instant itself is expired). */
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

/**
 * Claim `entry` for one invocation. Returns the claim, plus the entry's next
 * state when the claim consumed it; `next` is absent when nothing changed.
 * Throws {@link GrantClaimError} when the Grant cannot back this invocation.
 */
export function claimGrant<S extends AuthorizationSubject, C>(
  entry: GrantEntry<S, C> | undefined,
  grantId: string,
  invocationId: string,
  at: number
): { readonly claim: GrantClaim; readonly next?: GrantEntry<S, C> } {
  if (!entry) {
    throw new GrantClaimError(grantId, `Grant ${grantId} does not exist.`);
  }

  // Checked before liveness: a one-shot Grant is revoked *by* being claimed,
  // so the invocation that spent it must still be able to replay. Reading
  // liveness first would make a legitimate retry look revoked.
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

  // Lifetimes other than `once` are not consumed. The call still returns a
  // claim so the effect boundary has exactly one code path.
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

/**
 * Revoke `entry`. Returns its next state, or `undefined` when there is
 * nothing to change (never issued, or already gone). Throws
 * {@link GrantRevisionError} when `expectedRevision` is stale.
 */
export function revokeGrant<S extends AuthorizationSubject, C>(
  entry: GrantEntry<S, C> | undefined,
  grantId: string,
  expectedRevision?: number
): GrantEntry<S, C> | undefined {
  // A Grant this repository never issued cannot have moved under anyone.
  if (!entry) {
    return;
  }

  // Checked before the already-revoked short-circuit. Claiming and revoking
  // are both terminal, so every stale revision *also* looks like "already
  // gone" — answering that first would make `expectedRevision` unreachable
  // and silently turn a lost race into a success.
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

  // Revoking authority that is already gone is the state the caller wanted.
  if (entry.revoked) {
    return;
  }

  return {
    ...entry,
    grant: { ...entry.grant, revision: entry.grant.revision + 1 },
    revoked: true,
  };
}
