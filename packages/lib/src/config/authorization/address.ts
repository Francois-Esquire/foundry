/**
 * The identity authority is addressed by.
 *
 * A Grant is not "permission to use a tool called `web_fetch`". It is authority
 * for one durable Subject to exercise one versioned Capability under one
 * constraint set. Collapsing any of those three into the others is what made
 * the previous key under-namespaced: it hashed the capability payload alone, so
 * two agent presets exposing the same source and tool name shared authority
 * without any hash collision, and a capability schema change silently inherited
 * the older grant.
 *
 * The structured address is the domain identity. The digest in `./digest`
 * exists only so a database column or settings map can index it. A repository
 * may persist the digest alongside the address; it may never accept the digest
 * as the authority-bearing identity, because a digest cannot be inspected,
 * migrated, or explained to a user.
 *
 * This module is pure and renderer-importable: no `node:*` imports
 * (lint-guarded).
 */

/**
 * The durable thing authority belongs to — an agent preset, a module
 * installation, another host-defined identity.
 *
 * Hosts own the stronger type and the Principal proof that binds a runtime
 * actor to it; this module needs only a stable reference. `version` separates
 * generations of the same id, so a new preset generation does not inherit the
 * previous one's authority. Omit it only when the Subject genuinely has no
 * generations.
 */
export interface AuthorizationSubject {
  readonly id: string;
  readonly namespace: string;
  readonly version?: number;
}

/**
 * The versioned address of one privileged operation.
 *
 * `version` is the Capability *schema* version, not the host software version:
 * bumping it means the shape of what is being granted changed, so prior grants
 * must not carry over. `constraintsDigest` narrows the address to one
 * normalized constraint set — the host computes it, since only the host knows
 * which constraints are semantically significant.
 */
export interface CapabilityAddress {
  readonly constraintsDigest?: string;
  readonly id: string;
  readonly namespace: string;
  readonly version: number;
}

/**
 * One Subject plus one Capability, tagged with the schema that produced it.
 *
 * The `schema`/`version` pair is explicit so a stored address always declares
 * how to read it. Changing the encoding increments `version` and ships its own
 * migration rather than silently re-keying live authority.
 */
export interface AuthorizationAddress<S extends AuthorizationSubject> {
  readonly capability: CapabilityAddress;
  readonly schema: typeof AUTHORIZATION_ADDRESS_SCHEMA;
  readonly subject: S;
  readonly version: typeof AUTHORIZATION_ADDRESS_VERSION;
}

/**
 * The host adapter that knows how its own Subject and Capability types project
 * onto an address.
 *
 * This is deliberately the only way an address is produced. An untrusted caller
 * never supplies an address or a digest directly, because doing so would let it
 * assert a Subject/Capability relationship the host never sanctioned.
 */
export interface AuthorizationAddressing<S extends AuthorizationSubject, C> {
  addressOf: (subject: S, capability: C) => AuthorizationAddress<S>;
}

export const AUTHORIZATION_ADDRESS_SCHEMA = "foundry.authorization";
export const AUTHORIZATION_ADDRESS_VERSION = 1;

/** Build an address, stamping the current schema tag. */
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

/**
 * The canonical string form of an address — the equality used everywhere
 * authority is looked up, compared, or denied.
 *
 * Hand-written rather than derived from a generic value canonicalizer. The
 * shape is fixed and known, so encoding it field by field means a field added
 * to `AuthorizationSubject` cannot silently change every stored key, and the
 * golden vectors in the tests actually pin something.
 *
 * Injective by construction: every string field goes through
 * `JSON.stringify`, which escapes any embedded quote, so the quoted field
 * boundaries are unambiguous no matter what a namespace or id contains.
 * Absent optional members encode as a bare `-`, which no encoded string or
 * number can produce.
 */
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
