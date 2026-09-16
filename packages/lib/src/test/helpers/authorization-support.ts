/**
 * A fake host vocabulary for the authorization tests.
 *
 * The module under test is generic over the host's Subject and Capability, so
 * every test needs *some* vocabulary to bind. This one is deliberately small
 * and unlike either real host: two capability kinds, a versioned subject, and
 * an addressing adapter that puts the capability's own narrowing into the
 * constraints digest. If a test passes here it is testing the mechanism, not an
 * agent or module concept that leaked into it.
 */

import type {
  AuthorizationAddressing,
  AuthorizationSubject,
} from "../../config/authorization";

import { authorizationAddress } from "../../config/authorization";

export type TestCapability =
  | { readonly kind: "fs.read"; readonly root: string }
  | { readonly kind: "tool.call"; readonly name: string };

export type TestCapabilityKind = TestCapability["kind"];

const CAPABILITY_VERSION = 1;

export function kindOf(capability: TestCapability): TestCapabilityKind {
  return capability.kind;
}

/** A preset-shaped Subject: a stable id plus a generation. */
export function preset(id: string, version?: number): AuthorizationSubject {
  return version === undefined
    ? { id, namespace: "agent-preset" }
    : { id, namespace: "agent-preset", version };
}

export const fsRead = (root: string): TestCapability => ({
  kind: "fs.read",
  root,
});

export const toolCall = (name: string): TestCapability => ({
  kind: "tool.call",
  name,
});

/**
 * The host addressing adapter. `capabilityVersion` is a parameter so a test can
 * prove that bumping a Capability's schema version does not inherit authority
 * granted under the previous one.
 */
export function testAddressing(
  capabilityVersion: number = CAPABILITY_VERSION
): AuthorizationAddressing<AuthorizationSubject, TestCapability> {
  return {
    addressOf(subject, capability) {
      return authorizationAddress(subject, {
        constraintsDigest:
          capability.kind === "fs.read" ? capability.root : capability.name,
        id: capability.kind,
        namespace: "test",
        version: capabilityVersion,
      });
    },
  };
}

/** A clock a test drives by hand. */
export function testClock(start = 1000): {
  now: () => number;
  advance: (by: number) => void;
} {
  let current = start;
  return {
    advance: (by: number) => {
      current += by;
    },
    now: () => current,
  };
}
