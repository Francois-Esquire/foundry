/**
 * In-memory reference adapters.
 *
 * These are the executable definition of what the repository contracts mean —
 * a durable adapter is correct when it behaves like these. They are Promise-
 * shaped despite being maps, because the canonical contract is async and a
 * synchronous convenience variant is exactly how a second authority surface
 * gets introduced.
 */

import { KeyedQueue } from "../../keyed-queue";
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
  /** Issuance key → the ids issued under it. */
  const byIssuance = new Map<string, Set<string>>();
  let sequence = 0;

  function addId(map: Map<string, Set<string>>, key: string, id: string) {
    const ids = map.get(key) ?? new Set<string>();
    ids.add(id);
    map.set(key, ids);
  }

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
      addId(byAddress, encodeAddress(input.address), grant.id);
      if (input.issuanceKey !== undefined) {
        addId(byIssuance, input.issuanceKey, grant.id);
      }
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

    revokeIssuance(issuanceKey: string): Promise<void> {
      for (const id of byIssuance.get(issuanceKey) ?? []) {
        const next = revokeGrant(stored.get(id), id);
        if (next) {
          stored.set(id, next);
        }
      }
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
 * Capability is not collateral. Transitions on one Certificate id take turns,
 * and each Grant's issuance key is tracked before it is issued, so a revoke
 * reaches every Grant an issue made, even one whose `issue` stored it and then
 * failed.
 */
export function createInMemoryCertificateRepository<
  S extends AuthorizationSubject,
  C,
>(
  options: InMemoryCertificateRepositoryOptions<S, C>
): CertificateRepository<S, C> {
  const { grants, addressing } = options;
  const certificates = new Map<string, AuthorizationCertificate<S, C>>();
  /**
   * Certificate id → the issuance key of every Grant it may have issued that
   * is not yet known revoked.
   */
  const issuedGrants = new Map<string, string[]>();
  const transitions = new KeyedQueue();

  return {
    get(id: string): Promise<AuthorizationCertificate<S, C> | null> {
      return Promise.resolve(certificates.get(id) ?? null);
    },
    issue(
      certificate: AuthorizationCertificate<S, C>
    ): Promise<readonly Grant<S, C>[]> {
      return transitions.run(certificate.id, () => issueNow(certificate));
    },

    revoke(id: string, expectedVersion?: number): Promise<void> {
      return transitions.run(id, async () => {
        const certificate = certificates.get(id);
        if (
          certificate &&
          expectedVersion !== undefined &&
          expectedVersion !== certificate.version
        ) {
          throw new CertificateVersionError(
            id,
            expectedVersion,
            certificate.version
          );
        }

        // Also reached with no stored Certificate: a failed issue that could
        // not withdraw everything it made leaves the rest tracked here.
        await revokeGrantsOf(id);
        certificates.delete(id);
      });
    },
  };

  async function issueNow(
    certificate: AuthorizationCertificate<S, C>
  ): Promise<readonly Grant<S, C>[]> {
    // Re-issuing replaces the previous Certificate's authority rather than
    // stacking on it; a Profile edited to remove a capability must not leave
    // the removed Grant live.
    await revokeGrantsOf(certificate.id);

    const issued: Grant<S, C>[] = [];
    const tracked: string[] = [];
    issuedGrants.set(certificate.id, tracked);
    // Fresh per attempt, so a key never names a Grant from an earlier issue.
    const attempt = crypto.randomUUID();
    try {
      for (const [index, specification] of certificate.grants.entries()) {
        const address = addressing.addressOf(
          certificate.subject,
          specification.capability
        );
        const issuanceKey = `${certificate.id}:${attempt}:${String(index)}`;
        // Tracked before issuing: an issue can store its Grant and still reject.
        tracked.push(issuanceKey);
        // Operations are intentionally sequential to preserve observation and mutation order.
        const grant = await grants.issue({
          address,
          capability: specification.capability,
          certificateId: certificate.id,
          issuanceKey,
          lifetime: specification.lifetime,
          provenance: "certificate",
          ...(specification.expiresAt === undefined
            ? {}
            : { expiresAt: specification.expiresAt }),
        });
        issued.push(grant);
      }
    } catch (error) {
      // A half-issued Certificate is authority nobody authored. Any previous
      // record goes too: its Grants were revoked above, so keeping it would
      // store a Certificate that confers nothing.
      await revokeGrantsOf(certificate.id).catch(() => undefined);
      certificates.delete(certificate.id);
      throw error;
    }

    certificates.set(certificate.id, certificate);
    return issued;
  }

  async function revokeGrantsOf(certificateId: string): Promise<void> {
    const tracked = issuedGrants.get(certificateId) ?? [];
    while (tracked.length > 0) {
      const [issuanceKey] = tracked;
      if (issuanceKey !== undefined) {
        // Operations are intentionally sequential to preserve observation and mutation order.
        await grants.revokeIssuance(issuanceKey);
      }
      // Dropped only once revoked, so a failure leaves it for the next revoke.
      tracked.shift();
    }
    issuedGrants.delete(certificateId);
  }
}
