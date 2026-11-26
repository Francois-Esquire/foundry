import { z } from "zod";
import type {
  AuthorizationAddressing,
  AuthorizationSubject,
} from "../../authorization";

import { authorizationAddress } from "../../authorization";

export type TestCapability =
  | { readonly kind: "fs.read"; readonly root: string }
  | { readonly kind: "tool.call"; readonly name: string };

export type TestCapabilityKind = TestCapability["kind"];

const CAPABILITY_VERSION = 1;

export function kindOf(capability: TestCapability): TestCapabilityKind {
  return capability.kind;
}

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

export const testSubjectSchema = z.strictObject({
  id: z.string(),
  namespace: z.string(),
  version: z.int().nonnegative().optional(),
});

export const testCapabilitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fs.read"), root: z.string() }),
  z.strictObject({ kind: z.literal("tool.call"), name: z.string() }),
]);

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
