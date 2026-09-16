/**
 * In-memory reference adapters.
 *
 * These are the executable definition of what the repository contracts mean —
 * a durable adapter is correct when it behaves like these. They are Promise-
 * shaped despite being maps, because the canonical contract is async and a
 * synchronous convenience variant is exactly how a second authority surface
 * gets introduced.
 */

import type {
  AuthorizationAddress,
  AuthorizationAddressing,
  AuthorizationSubject,
} from "./address";
import { encodeAddress } from "./address";
import type {
  AuthorizationCertificate,
  CertificateRepository,
} from "./certificate";
import { CertificateVersionError } from "./certificate";
import type { Grant, GrantClaim, GrantInput, GrantRepository } from "./grant";
import { GrantClaimError, GrantRevisionError } from "./grant";

export interface InMemoryGrantRepositoryOptions {
  /** Injected so expiry is testable. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface StoredGrant<S extends AuthorizationSubject, C> {
  /** The claim that consumed this Grant, if it was one-shot and has been taken. */
  claim?: GrantClaim;
  grant: Grant<S, C>;
  revoked: boolean;
}

/**
 * Reference {@link GrantRepository}. Deny by default: no address starts with a
 * live Grant.
 */
export function createInMemoryGrantRepository<
  S extends AuthorizationSubject,
  C,
>(options: InMemoryGrantRepositoryOptions = {}): GrantRepository<S, C> {
  const { now = Date.now } = options;
  const stored = new Map<string, StoredGrant<S, C>>();
  /** Address key → the ids issued at it, so `find` is a lookup and not a scan. */
  const byAddress = new Map<string, Set<string>>();
  let sequence = 0;

  function isLive(entry: StoredGrant<S, C>, at: number): boolean {
    if (entry.revoked) {
      return false;
    }
    const { expiresAt } = entry.grant;
    return expiresAt === undefined || expiresAt > at;
  }

  return {
    claimOnce(grantId: string, invocationId: string): Promise<GrantClaim> {
      const entry = stored.get(grantId);
      if (!entry) {
        return Promise.reject(
          new GrantClaimError(grantId, `Grant ${grantId} does not exist.`)
        );
      }

      // Checked before liveness: a one-shot Grant is revoked *by* being
      // claimed, so the invocation that spent it must still be able to replay.
      // Reading liveness first would make a legitimate retry look revoked.
      if (entry.claim) {
        if (entry.claim.invocationId === invocationId) {
          return Promise.resolve(entry.claim);
        }
        return Promise.reject(
          new GrantClaimError(
            grantId,
            `Grant ${grantId} is one-shot and was already claimed by another invocation.`
          )
        );
      }

      if (!isLive(entry, now())) {
        return Promise.reject(
          new GrantClaimError(
            grantId,
            `Grant ${grantId} is revoked or expired.`
          )
        );
      }

      // Lifetimes other than `once` are not consumed. The call still returns a
      // claim so the effect boundary has exactly one code path.
      if (entry.grant.lifetime.kind !== "once") {
        return Promise.resolve({
          grantId,
          invocationId,
          revision: entry.grant.revision,
        });
      }

      const revision = entry.grant.revision + 1;
      entry.grant = { ...entry.grant, revision };
      entry.revoked = true;
      entry.claim = { grantId, invocationId, revision };
      return Promise.resolve(entry.claim);
    },

    find(
      address: AuthorizationAddress<S>,
      at: number
    ): Promise<readonly Grant<S, C>[]> {
      const ids = byAddress.get(encodeAddress(address));
      if (!ids) {
        return Promise.resolve([]);
      }

      const live: Grant<S, C>[] = [];
      for (const id of ids) {
        const entry = stored.get(id);
        if (entry && isLive(entry, at)) {
          live.push(entry.grant);
        }
      }
      return Promise.resolve(live);
    },
    issue(input: GrantInput<S, C>): Promise<Grant<S, C>> {
      sequence += 1;
      const id = `grant_${String(sequence)}`;
      const grant: Grant<S, C> = {
        address: input.address,
        capability: input.capability,
        id,
        issuedAt: now(),
        lifetime: input.lifetime,
        provenance: input.provenance,
        revision: 1,
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: input.expiresAt }),
        ...(input.certificateId === undefined
          ? {}
          : { certificateId: input.certificateId }),
      };
      stored.set(id, { grant, revoked: false });

      const key = encodeAddress(input.address);
      const ids = byAddress.get(key) ?? new Set<string>();
      ids.add(id);
      byAddress.set(key, ids);

      return Promise.resolve(grant);
    },

    revoke(grantId: string, expectedRevision?: number): Promise<void> {
      const entry = stored.get(grantId);
      // A Grant this repository never issued cannot have moved under anyone.
      if (!entry) {
        return Promise.resolve();
      }

      // Checked before the already-revoked short-circuit. Claiming and revoking
      // are both terminal, so every stale revision *also* looks like "already
      // gone" — answering that first would make `expectedRevision` unreachable
      // and silently turn a lost race into a success.
      if (
        expectedRevision !== undefined &&
        expectedRevision !== entry.grant.revision
      ) {
        return Promise.reject(
          new GrantRevisionError(
            grantId,
            expectedRevision,
            entry.grant.revision
          )
        );
      }

      // Revoking authority that is already gone is the state the caller wanted.
      if (entry.revoked) {
        return Promise.resolve();
      }

      entry.revoked = true;
      entry.grant = { ...entry.grant, revision: entry.grant.revision + 1 };
      return Promise.resolve();
    },
  };
}

export interface InMemoryCertificateRepositoryOptions<
  S extends AuthorizationSubject,
  C,
> {
  /** How the Certificate's Subject and each specified Capability become an address. */
  readonly addressing: AuthorizationAddressing<S, C>;
  /** Where the Certificate's derived Grants are written. */
  readonly grants: GrantRepository<S, C>;
}

/**
 * Reference {@link CertificateRepository}.
 *
 * Issue and revoke move the Certificate and its Grants together. A Certificate
 * is stored only once all of its Grants exist, and revoking one touches only
 * the Grants that Certificate contributed — a human's own decision on the same
 * Capability is not collateral.
 */
export function createInMemoryCertificateRepository<
  S extends AuthorizationSubject,
  C,
>(
  options: InMemoryCertificateRepositoryOptions<S, C>
): CertificateRepository<S, C> {
  const { grants, addressing } = options;
  const certificates = new Map<string, AuthorizationCertificate<S, C>>();
  const issuedGrants = new Map<string, readonly string[]>();

  return {
    get(id: string): Promise<AuthorizationCertificate<S, C> | null> {
      return Promise.resolve(certificates.get(id) ?? null);
    },
    async issue(
      certificate: AuthorizationCertificate<S, C>
    ): Promise<readonly Grant<S, C>[]> {
      // Re-issuing replaces the previous Certificate's authority rather than
      // stacking on it; a Profile edited to remove a capability must not leave
      // the removed Grant live.
      await revokeGrantsOf(certificate.id);

      const issued: Grant<S, C>[] = [];
      for (const specification of certificate.grants) {
        const address = addressing.addressOf(
          certificate.subject,
          specification.capability
        );
        issued.push(
          // biome-ignore lint/performance/noAwaitInLoops: Operations are intentionally sequential to preserve observation and mutation order.
          await grants.issue({
            address,
            capability: specification.capability,
            certificateId: certificate.id,
            lifetime: specification.lifetime,
            provenance: "certificate",
            ...(specification.expiresAt === undefined
              ? {}
              : { expiresAt: specification.expiresAt }),
          })
        );
      }

      certificates.set(certificate.id, certificate);
      issuedGrants.set(
        certificate.id,
        issued.map((grant) => grant.id)
      );
      return issued;
    },

    async revoke(id: string, expectedVersion?: number): Promise<void> {
      const certificate = certificates.get(id);
      if (!certificate) {
        return;
      }

      if (
        expectedVersion !== undefined &&
        expectedVersion !== certificate.version
      ) {
        throw new CertificateVersionError(
          id,
          expectedVersion,
          certificate.version
        );
      }

      await revokeGrantsOf(id);
      certificates.delete(id);
    },
  };

  async function revokeGrantsOf(certificateId: string): Promise<void> {
    for (const grantId of issuedGrants.get(certificateId) ?? []) {
      // biome-ignore lint/performance/noAwaitInLoops: Operations are intentionally sequential to preserve observation and mutation order.
      await grants.revoke(grantId);
    }
    issuedGrants.delete(certificateId);
  }
}
