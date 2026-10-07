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
import type { GrantEntry } from "./grant-state";
import {
  claimGrant,
  grantIdFor,
  isLiveGrant,
  issuedGrant,
  revokeGrant,
} from "./grant-state";

export interface InMemoryGrantRepositoryOptions {
  /** Injected so expiry is testable. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Reference {@link GrantRepository}. Deny by default: no address starts with a
 * live Grant. Its transitions are the shared ones in `./grant-state`.
 */
export function createInMemoryGrantRepository<
  S extends AuthorizationSubject,
  C,
>(options: InMemoryGrantRepositoryOptions = {}): GrantRepository<S, C> {
  const { now = Date.now } = options;
  const stored = new Map<string, GrantEntry<S, C>>();
  /** Address key → the ids issued at it, so `find` is a lookup and not a scan. */
  const byAddress = new Map<string, Set<string>>();
  let sequence = 0;

  return {
    claimOnce(grantId: string, invocationId: string): Promise<GrantClaim> {
      try {
        const { claim, next } = claimGrant(
          stored.get(grantId),
          grantId,
          invocationId,
          now()
        );
        if (next) {
          stored.set(grantId, next);
        }
        return Promise.resolve(claim);
      } catch (error) {
        return Promise.reject(error);
      }
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
        if (entry && isLiveGrant(entry, at)) {
          live.push(entry.grant);
        }
      }
      return Promise.resolve(live);
    },
    issue(input: GrantInput<S, C>): Promise<Grant<S, C>> {
      sequence += 1;
      const grant = issuedGrant(input, grantIdFor(sequence), now());
      stored.set(grant.id, { grant, revoked: false });

      const key = encodeAddress(input.address);
      const ids = byAddress.get(key) ?? new Set<string>();
      ids.add(grant.id);
      byAddress.set(key, ids);

      return Promise.resolve(grant);
    },

    revoke(grantId: string, expectedRevision?: number): Promise<void> {
      try {
        const next = revokeGrant(
          stored.get(grantId),
          grantId,
          expectedRevision
        );
        if (next) {
          stored.set(grantId, next);
        }
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
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
          // Operations are intentionally sequential to preserve observation and mutation order.
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
      // Operations are intentionally sequential to preserve observation and mutation order.
      await grants.revoke(grantId);
    }
    issuedGrants.delete(certificateId);
  }
}
