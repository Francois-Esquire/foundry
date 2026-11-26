import type { AuthorizationSubject } from "./address";
import type { Grant, GrantLifetime } from "./grant";

export interface GrantSpecification<C> {
  readonly capability: C;
  readonly expiresAt?: number;
  readonly lifetime: GrantLifetime;
  readonly reason?: string;
}

export interface AuthorizationProfile<C> {
  readonly grants: readonly GrantSpecification<C>[];
  readonly id: string;
  readonly version: number;
}

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
