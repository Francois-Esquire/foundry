/**
 * Authored Profiles and issued Certificates.
 *
 * The distinction is the point. A **Profile** is declarative configuration —
 * a named list of grant specifications an agent preset or a module manifest may
 * author or request. It confers nothing. A **Certificate** is that Profile
 * actually issued to one Subject by one trusted issuer: versioned, persisted,
 * and revocable as an aggregate.
 *
 * Collapsing them is how untrusted content ends up granting itself authority.
 * A manifest that ships a "capabilities" list is authoring a Profile; only
 * trusted host composition turns one into a Certificate.
 */

import type { AuthorizationSubject } from "./address";
import type { Grant, GrantLifetime } from "./grant";

/** One entry in a Profile: what may be granted, for how long, and why. */
export interface GrantSpecification<C> {
  readonly capability: C;
  readonly expiresAt?: number;
  readonly lifetime: GrantLifetime;
  readonly reason?: string;
}

/**
 * A named, versioned collection of grant specifications.
 *
 * Carries no Subject: a Profile is a template that has not been issued to
 * anyone yet. `version` is what stops an edited Profile from silently applying
 * to Certificates already issued from an earlier revision of it.
 */
export interface AuthorizationProfile<C> {
  readonly grants: readonly GrantSpecification<C>[];
  readonly id: string;
  readonly version: number;
}

/**
 * A Profile issued to one Subject by one issuer.
 *
 * `proof` is optional while Certificates stay host-local and are verified
 * against trusted host persistence. Issuance, version, expiry, and revocation
 * are not optional at any stage — a Certificate that cannot be revoked is just
 * a configuration file with a more confident name.
 */
export interface AuthorizationCertificate<S extends AuthorizationSubject, C> {
  readonly expiresAt?: number;
  readonly grants: readonly GrantSpecification<C>[];
  readonly id: string;
  readonly issuedAt: number;
  readonly issuer: AuthorizationSubject;
  readonly profileId?: string;
  readonly proof?: string;
  readonly subject: S;
  readonly version: number;
}

/** Thrown when a revoke presents a version that is no longer current. */
export class CertificateVersionError extends Error {
  readonly certificateId: string;
  readonly expected: number;
  readonly actual: number;

  constructor(certificateId: string, expected: number, actual: number) {
    super(
      `Certificate ${certificateId} is at version ${String(actual)}, not ${String(expected)}.`
    );
    this.name = "CertificateVersionError";
    this.certificateId = certificateId;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Issued Certificates and the Grants derived from them.
 *
 * `issue` and `revoke` move the Certificate and its Grants together; neither is
 * a loop the caller drives, because a half-issued Certificate is authority
 * nobody authored. Revoking one Certificate removes only the Grants that
 * Certificate contributed — a human's own decision on the same Capability
 * survives it.
 */
export interface CertificateRepository<S extends AuthorizationSubject, C> {
  get: (id: string) => Promise<AuthorizationCertificate<S, C> | null>;
  issue: (
    certificate: AuthorizationCertificate<S, C>
  ) => Promise<readonly Grant<S, C>[]>;
  revoke: (id: string, expectedVersion?: number) => Promise<void>;
}

export interface CertificateForProfileOptions<
  S extends AuthorizationSubject,
  C,
> {
  readonly expiresAt?: number;
  readonly id: string;
  readonly issuedAt: number;
  readonly issuer: AuthorizationSubject;
  readonly profile: AuthorizationProfile<C>;
  readonly proof?: string;
  readonly subject: S;
}

/**
 * Bind an authored Profile to one Subject and issuer.
 *
 * Construction only — calling it is the trusted host's decision, and the
 * resulting Certificate confers nothing until a {@link CertificateRepository}
 * issues it. The Certificate inherits the Profile's version so a stored
 * Certificate always records which revision of the Profile it came from.
 */
export function certificateForProfile<S extends AuthorizationSubject, C>(
  options: CertificateForProfileOptions<S, C>
): AuthorizationCertificate<S, C> {
  const { profile } = options;
  return {
    grants: profile.grants,
    id: options.id,
    issuedAt: options.issuedAt,
    issuer: options.issuer,
    profileId: profile.id,
    subject: options.subject,
    version: profile.version,
    ...(options.expiresAt === undefined
      ? {}
      : { expiresAt: options.expiresAt }),
    ...(options.proof === undefined ? {} : { proof: options.proof }),
  };
}
