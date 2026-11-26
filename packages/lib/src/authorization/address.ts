export interface AuthorizationSubject {
  readonly id: string;
  readonly namespace: string;
  readonly version?: number;
}

export interface CapabilityAddress {
  readonly constraintsDigest?: string;
  readonly id: string;
  readonly namespace: string;
  readonly version: number;
}

export interface AuthorizationAddress<S extends AuthorizationSubject> {
  readonly capability: CapabilityAddress;
  readonly schema: typeof AUTHORIZATION_ADDRESS_SCHEMA;
  readonly subject: S;
  readonly version: typeof AUTHORIZATION_ADDRESS_VERSION;
}

export interface AuthorizationAddressing<S extends AuthorizationSubject, C> {
  addressOf: (subject: S, capability: C) => AuthorizationAddress<S>;
}

export const AUTHORIZATION_ADDRESS_SCHEMA = "foundry.authorization";
export const AUTHORIZATION_ADDRESS_VERSION = 1;

export function authorizationAddress<S extends AuthorizationSubject>(
  subject: S,
  capability: CapabilityAddress
): AuthorizationAddress<S> {
  return {
    capability,
    schema: AUTHORIZATION_ADDRESS_SCHEMA,
    subject,
    version: AUTHORIZATION_ADDRESS_VERSION,
  };
}

export function encodeAddress<S extends AuthorizationSubject>(
  address: AuthorizationAddress<S>
): string {
  const { subject, capability } = address;
  return [
    address.schema,
    String(address.version),
    JSON.stringify(subject.namespace),
    JSON.stringify(subject.id),
    subject.version === undefined ? "-" : String(subject.version),
    JSON.stringify(capability.namespace),
    JSON.stringify(capability.id),
    String(capability.version),
    capability.constraintsDigest === undefined
      ? "-"
      : JSON.stringify(capability.constraintsDigest),
  ].join("|");
}
