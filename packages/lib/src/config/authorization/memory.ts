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
  readonly now?: () => number;
}

export function createInMemoryGrantRepository<
  S extends AuthorizationSubject,
  C,
>(options: InMemoryGrantRepositoryOptions = {}): GrantRepository<S, C> {
  const { now = Date.now } = options;
  const stored = new Map<string, GrantEntry<S, C>>();
  const byAddress = new Map<string, Set<string>>();
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
  readonly addressing: AuthorizationAddressing<S, C>;
  readonly grants: GrantRepository<S, C>;
}

export function createInMemoryCertificateRepository<
  S extends AuthorizationSubject,
  C,
>(
  options: InMemoryCertificateRepositoryOptions<S, C>
): CertificateRepository<S, C> {
  const { grants, addressing } = options;
  const certificates = new Map<string, AuthorizationCertificate<S, C>>();
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

        await revokeGrantsOf(id);
        certificates.delete(id);
      });
    },
  };

  async function issueNow(
    certificate: AuthorizationCertificate<S, C>
  ): Promise<readonly Grant<S, C>[]> {
    await revokeGrantsOf(certificate.id);

    const issued: Grant<S, C>[] = [];
    const tracked: string[] = [];
    issuedGrants.set(certificate.id, tracked);
    const attempt = crypto.randomUUID();
    try {
      for (const [index, specification] of certificate.grants.entries()) {
        const address = addressing.addressOf(
          certificate.subject,
          specification.capability
        );
        const issuanceKey = `${certificate.id}:${attempt}:${String(index)}`;
        tracked.push(issuanceKey);
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
        await grants.revokeIssuance(issuanceKey);
      }
      tracked.shift();
    }
    issuedGrants.delete(certificateId);
  }
}
