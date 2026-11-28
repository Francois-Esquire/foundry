import {
  AuthorizationDeniedError,
  AuthorizationNotFoundError,
  AuthorizationStateError,
} from "./errors";
import {
  findBlockingDenyForGrantScope,
  isExpired,
  samePrincipalIdentity,
  walkDelegationAncestors,
} from "./evaluation";
import { uniqueIds } from "./grant-loader";
import type {
  ApproveGrantInput,
  Grant,
  GrantApproval,
  GrantId,
  IssueGrantInput,
  Restriction,
} from "./schema";
import {
  matchesPrincipal,
  type NarrowOptions,
  narrows,
  type Scope,
} from "./scope";

interface TightenedGrantFields {
  readonly canDelegate: boolean;
  readonly expiresAt?: number;
  readonly scope: Scope;
  readonly sessionId?: string;
  readonly usesRemaining?: number;
}

export function validateParentDelegations(
  parentIds: readonly GrantId[],
  grantMap: ReadonlyMap<GrantId, Grant>,
  input: IssueGrantInput,
  now: number,
  narrowOptions?: NarrowOptions
): ReadonlySet<GrantId> {
  if (parentIds.length === 0) {
    return new Set();
  }
  const ancestorOrder = walkDelegationAncestors(parentIds, grantMap, now, {
    sessionId: input.sessionId,
  });
  if (ancestorOrder === null) {
    throw new AuthorizationStateError(
      "Parent grant chain is missing, inactive, expired, non-delegable, or cyclic"
    );
  }
  for (const parentId of parentIds) {
    const parent = grantMap.get(parentId);
    if (parent === undefined) {
      throw new AuthorizationNotFoundError("grant", parentId);
    }
    if (
      input.issuer !== undefined &&
      !matchesPrincipal(parent.holder, input.issuer, "allow")
    ) {
      throw new AuthorizationStateError(
        `Issuer does not hold parent grant ${parentId}`
      );
    }
    assertNarrowsParent(
      parent,
      {
        expiresAt: input.expiresAt,
        scope: input.scope,
        sessionId: input.sessionId,
        usesRemaining: input.usesRemaining,
      },
      narrowOptions
    );
  }
  return new Set(ancestorOrder);
}

export function prepareApproval(
  existing: Grant,
  input: ApproveGrantInput,
  grantMap: ReadonlyMap<GrantId, Grant>,
  restrictions: readonly Restriction[],
  now: number,
  narrowOptions?: NarrowOptions
): { readonly approval: GrantApproval; readonly updated: Grant } {
  if (existing.state !== "pending") {
    throw new AuthorizationStateError(
      `Cannot approve grant ${existing.id} in state ${existing.state}`
    );
  }
  if (isExpired(existing, now)) {
    throw new AuthorizationStateError(`Grant ${existing.id} has expired`);
  }
  if (
    input.allowSelfApproval !== true &&
    samePrincipalIdentity(input.approver, existing.requestedBy)
  ) {
    throw new AuthorizationStateError("Self-approval is not permitted");
  }
  if (
    existing.approvals.some((entry) =>
      samePrincipalIdentity(entry.approver, input.approver)
    )
  ) {
    throw new AuthorizationStateError(
      `Approver ${input.approver.kind}:${input.approver.id} has already approved grant ${existing.id}`
    );
  }
  const tightened = tightenPendingGrant(existing, input, narrowOptions);
  const parentIds = uniqueIds([
    ...existing.parentIds,
    ...(input.parentGrantId === undefined ? [] : [input.parentGrantId]),
  ]);
  const ancestors = verifyApproverAuthority(
    input,
    tightened,
    parentIds,
    existing.invocationId,
    grantMap,
    now,
    narrowOptions
  );
  const blocking = findBlockingDenyForGrantScope(
    existing.holder,
    tightened.scope,
    ancestors,
    restrictions,
    narrowOptions
  );
  if (blocking !== undefined) {
    throw new AuthorizationDeniedError(blocking.reason, blocking.id);
  }
  const approval: GrantApproval = {
    approver: input.approver,
    at: now,
    ...(input.parentGrantId === undefined
      ? {}
      : { parentGrantId: input.parentGrantId }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
  const nextApprovals = [...existing.approvals, approval];
  const activated = nextApprovals.length >= existing.requiredApprovals;
  const updated: Grant = {
    ...existing,
    approvals: nextApprovals,
    canDelegate: tightened.canDelegate,
    ...(tightened.expiresAt === undefined
      ? {}
      : { expiresAt: tightened.expiresAt }),
    parentIds,
    revision: existing.revision + 1,
    scope: tightened.scope,
    ...(tightened.sessionId === undefined
      ? {}
      : { sessionId: tightened.sessionId }),
    state: activated ? "active" : "pending",
    updatedAt: now,
    ...(tightened.usesRemaining === undefined
      ? {}
      : { usesRemaining: tightened.usesRemaining }),
  };
  return { approval, updated };
}

function tightenPendingGrant(
  existing: Grant,
  input: ApproveGrantInput,
  narrowOptions?: NarrowOptions
): TightenedGrantFields {
  const scope = input.scope ?? existing.scope;
  if (
    input.scope !== undefined &&
    !narrows(input.scope, existing.scope, narrowOptions)
  ) {
    throw new AuthorizationStateError(
      "Approval scope cannot widen the requested grant scope"
    );
  }
  const expiresAt = input.expiresAt ?? existing.expiresAt;
  if (
    input.expiresAt !== undefined &&
    existing.expiresAt !== undefined &&
    input.expiresAt > existing.expiresAt
  ) {
    throw new AuthorizationStateError(
      "Approval expiresAt cannot exceed the requested grant expiration"
    );
  }
  const usesRemaining = input.usesRemaining ?? existing.usesRemaining;
  if (
    input.usesRemaining !== undefined &&
    existing.usesRemaining !== undefined &&
    input.usesRemaining > existing.usesRemaining
  ) {
    throw new AuthorizationStateError(
      "Approval usesRemaining cannot exceed the requested grant uses"
    );
  }
  const sessionId = input.sessionId ?? existing.sessionId;
  if (
    input.sessionId !== undefined &&
    existing.sessionId !== undefined &&
    input.sessionId !== existing.sessionId
  ) {
    throw new AuthorizationStateError(
      "Approval sessionId cannot change an existing session restriction"
    );
  }
  const canDelegate = input.canDelegate ?? existing.canDelegate;
  if (canDelegate && !existing.canDelegate) {
    throw new AuthorizationStateError(
      "Approval cannot enable delegation on a non-delegable grant request"
    );
  }
  return { canDelegate, expiresAt, scope, sessionId, usesRemaining };
}

function verifyApproverAuthority(
  input: ApproveGrantInput,
  tightened: TightenedGrantFields,
  allParentIds: readonly GrantId[],
  invocationId: string | undefined,
  grantMap: ReadonlyMap<GrantId, Grant>,
  now: number,
  narrowOptions?: NarrowOptions
): ReadonlySet<GrantId> {
  if (input.parentGrantId === undefined) {
    if (input.rootAuthority !== true) {
      throw new AuthorizationStateError(
        "Approval requires either parentGrantId or rootAuthority: true"
      );
    }
    if (allParentIds.length === 0) {
      return new Set();
    }
    const existingAncestors = walkDelegationAncestors(
      allParentIds,
      grantMap,
      now,
      { invocationId, sessionId: tightened.sessionId }
    );
    if (existingAncestors === null) {
      throw new AuthorizationStateError(
        "Existing parent grant chain is no longer active or delegable"
      );
    }
    return new Set(existingAncestors);
  }
  const parent = grantMap.get(input.parentGrantId);
  if (parent === undefined) {
    throw new AuthorizationNotFoundError("grant", input.parentGrantId);
  }
  if (!matchesPrincipal(parent.holder, input.approver, "allow")) {
    throw new AuthorizationStateError(
      `Approver does not hold parent grant ${input.parentGrantId}`
    );
  }
  const ancestors = walkDelegationAncestors(allParentIds, grantMap, now, {
    invocationId,
    sessionId: tightened.sessionId,
  });
  if (ancestors === null) {
    throw new AuthorizationStateError(
      "Approver parent grant chain is inactive, expired, non-delegable, or cyclic"
    );
  }
  assertNarrowsParent(parent, tightened, narrowOptions);
  return new Set(ancestors);
}

function assertNarrowsParent(
  parent: Grant,
  child: {
    readonly expiresAt?: number;
    readonly scope: Scope;
    readonly sessionId?: string;
    readonly usesRemaining?: number;
  },
  narrowOptions?: NarrowOptions
): void {
  if (!narrows(child.scope, parent.scope, narrowOptions)) {
    throw new AuthorizationStateError(
      `Child scope does not narrow parent grant ${parent.id}`
    );
  }
  if (
    parent.expiresAt !== undefined &&
    (child.expiresAt === undefined || child.expiresAt > parent.expiresAt)
  ) {
    throw new AuthorizationStateError(
      `Child expiresAt exceeds parent grant ${parent.id}`
    );
  }
  if (
    parent.usesRemaining !== undefined &&
    (child.usesRemaining === undefined ||
      child.usesRemaining > parent.usesRemaining)
  ) {
    throw new AuthorizationStateError(
      `Child usesRemaining exceeds parent grant ${parent.id}`
    );
  }
  if (parent.sessionId !== undefined && child.sessionId !== parent.sessionId) {
    throw new AuthorizationStateError(
      `Child sessionId must match parent grant ${parent.id}`
    );
  }
}
