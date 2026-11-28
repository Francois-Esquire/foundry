import { sha256Hex } from "@foundry/lib/digest";
import { canonicalizeJson } from "@foundry/lib/json";
import {
  AuthorizationStateError,
  AuthorizationValidationError,
} from "./errors";
import { isExpired } from "./evaluation";
import type {
  Grant,
  GrantId,
  GrantState,
  IssueGrantInput,
  RequestGrantInput,
} from "./schema";
import type {
  AccessRequest,
  Principal,
  PrincipalMatcher,
  Scope,
} from "./scope";

export interface BuildGrantFields {
  readonly canDelegate: boolean;
  readonly expiresAt?: number;
  readonly holder: PrincipalMatcher;
  readonly id: GrantId;
  readonly invocationId?: string;
  readonly issuanceKey?: string;
  readonly now: number;
  readonly parentIds: readonly GrantId[];
  readonly reason?: string;
  readonly requestedBy: Principal;
  readonly requiredApprovals: number;
  readonly scope: Scope;
  readonly sessionId?: string;
  readonly state: GrantState;
  readonly usesRemaining?: number;
}

export function buildGrant(fields: BuildGrantFields): Grant {
  return {
    approvals: [],
    canDelegate: fields.canDelegate,
    createdAt: fields.now,
    ...(fields.expiresAt === undefined ? {} : { expiresAt: fields.expiresAt }),
    holder: fields.holder,
    id: fields.id,
    ...(fields.invocationId === undefined
      ? {}
      : { invocationId: fields.invocationId }),
    ...(fields.issuanceKey === undefined
      ? {}
      : { issuanceKey: fields.issuanceKey }),
    parentIds: fields.parentIds,
    ...(fields.reason === undefined ? {} : { reason: fields.reason }),
    requestedBy: fields.requestedBy,
    requiredApprovals: fields.requiredApprovals,
    revision: 1,
    scope: fields.scope,
    ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
    state: fields.state,
    updatedAt: fields.now,
    ...(fields.usesRemaining === undefined
      ? {}
      : { usesRemaining: fields.usesRemaining }),
  };
}

export function assertUnusedGrantRecord(
  id: GrantId | undefined,
  existing: Grant | null
): void {
  if (id !== undefined && existing !== null) {
    throw new AuthorizationValidationError(`Grant id ${id} already exists`);
  }
}

export function reusePendingRequest(
  pendingForInvocation: readonly Grant[],
  input: RequestGrantInput,
  requiredApprovals: number,
  at: number
): Grant | undefined {
  if (input.invocationId === undefined) {
    return;
  }
  const [existing] = pendingForInvocation;
  if (existing === undefined) {
    return;
  }
  if (isExpired(existing, at)) {
    throw new AuthorizationStateError(
      `Pending grant for invocation ${input.invocationId} has expired`
    );
  }
  if (!matchesPendingGrantRequestInput(existing, input, requiredApprovals)) {
    throw new AuthorizationStateError(
      `Invocation ${input.invocationId} is already bound to a different pending grant`
    );
  }
  return existing;
}

export function reuseIdempotentIssuance(
  issuanceGrants: readonly Grant[],
  input: IssueGrantInput,
  parentIds: readonly GrantId[]
): Grant | undefined {
  if (input.issuanceKey === undefined) {
    return;
  }
  const duplicate = findIdempotentIssuance(
    issuanceGrants,
    input.issuanceKey,
    input.holder,
    input.scope,
    parentIds,
    input.sessionId
  );
  if (duplicate === undefined) {
    return;
  }
  if (
    duplicate.canDelegate !== (input.canDelegate ?? false) ||
    duplicate.expiresAt !== input.expiresAt ||
    duplicate.usesRemaining !== input.usesRemaining
  ) {
    throw new AuthorizationStateError(
      `Issuance key ${input.issuanceKey} already issued a grant with different bounds`
    );
  }
  return duplicate;
}

export function validateGrantBounds(input: {
  readonly expiresAt?: number;
  readonly usesRemaining?: number;
}): void {
  if (input.usesRemaining !== undefined) {
    assertPositiveInteger(input.usesRemaining, "usesRemaining");
  }
  if (input.expiresAt !== undefined) {
    assertFiniteNumber(input.expiresAt, "expiresAt");
  }
}

export function matchesPendingGrantForRequest(
  grant: Grant,
  request: AccessRequest,
  scope: Scope
): boolean {
  try {
    return (
      canonicalizeJson({
        holder: grant.holder,
        scope: grant.scope,
        sessionId: grant.sessionId ?? null,
      }) ===
      canonicalizeJson({
        holder: {
          kind: "exact",
          principal: exactPrincipalRef(request.principal),
        },
        scope,
        sessionId: request.sessionId ?? null,
      })
    );
  } catch {
    return false;
  }
}

export async function fingerprintRequest(
  request: AccessRequest
): Promise<string | null> {
  const canonical = canonicalizeRequest(request);
  if (canonical === null) {
    return null;
  }
  return await sha256Hex(canonical);
}

export async function matchesRequestFingerprint(
  storedFingerprint: string | undefined,
  request: AccessRequest
): Promise<boolean> {
  if (storedFingerprint === undefined) {
    return false;
  }
  const canonical = canonicalizeRequest(request);
  if (canonical === null) {
    return false;
  }
  if (storedFingerprint === canonical) {
    return true;
  }
  return storedFingerprint === (await sha256Hex(canonical));
}

export function exactPrincipalRef(
  principal: Principal
): Pick<Principal, "kind" | "id" | "version"> {
  return {
    id: principal.id,
    kind: principal.kind,
    ...(principal.version === undefined ? {} : { version: principal.version }),
  };
}

export function assertNonEmptyText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthorizationValidationError(
      `${field} must be a non-empty string`
    );
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AuthorizationValidationError(
      `${field} must be a positive safe integer`
    );
  }
}

export function validateScope(scope: Scope): void {
  assertNonEmptyText(scope.action, "scope.action");
}

function assertFiniteNumber(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AuthorizationValidationError(`${field} must be a finite number`);
  }
}

function matchesPendingGrantRequestInput(
  grant: Grant,
  input: RequestGrantInput,
  requiredApprovals: number
): boolean {
  try {
    return (
      grant.canDelegate === (input.canDelegate ?? false) &&
      grant.expiresAt === input.expiresAt &&
      grant.requiredApprovals === requiredApprovals &&
      grant.usesRemaining === input.usesRemaining &&
      canonicalizeJson({
        holder: grant.holder,
        scope: grant.scope,
        sessionId: grant.sessionId ?? null,
      }) ===
        canonicalizeJson({
          holder: input.holder,
          scope: input.scope,
          sessionId: input.sessionId ?? null,
        })
    );
  } catch {
    return false;
  }
}

function stripUndefinedProperties(
  record: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> | null {
  if (record === undefined) {
    return null;
  }
  return stripUndefinedValue(record, new WeakSet()) as Record<string, unknown>;
}

function stripUndefinedValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      return value.map((item) => stripUndefinedValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  seen.add(value);
  try {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue;
      }
      Object.defineProperty(out, key, {
        configurable: true,
        enumerable: true,
        value: stripUndefinedValue(item, seen),
        writable: true,
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function canonicalizeRequest(request: AccessRequest): string | null {
  try {
    return canonicalizeJson({
      action: request.action,
      attributes: stripUndefinedProperties(request.attributes),
      constraintsDigest: request.constraintsDigest ?? null,
      principal: {
        attributes: stripUndefinedProperties(request.principal.attributes),
        id: request.principal.id,
        kind: request.principal.kind,
        version: request.principal.version ?? null,
      },
      sessionId: request.sessionId ?? null,
      target: request.target,
    });
  } catch {
    return null;
  }
}

function findIdempotentIssuance(
  grants: readonly Grant[],
  issuanceKey: string,
  holder: PrincipalMatcher,
  scope: Scope,
  parentIds: readonly GrantId[],
  sessionId: string | undefined
): Grant | undefined {
  const fingerprint = canonicalizeJson({
    holder,
    parentIds,
    scope,
    sessionId: sessionId ?? null,
  });
  return grants.find(
    (grant) =>
      grant.issuanceKey === issuanceKey &&
      canonicalizeJson({
        holder: grant.holder,
        parentIds: grant.parentIds,
        scope: grant.scope,
        sessionId: grant.sessionId ?? null,
      }) === fingerprint
  );
}
