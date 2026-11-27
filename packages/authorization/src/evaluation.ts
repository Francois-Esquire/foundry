import type { Grant, GrantId, Restriction } from "./schema";
import type {
  AccessRequest,
  ConstraintBound,
  NarrowOptions,
  Principal,
  PrincipalMatcher,
  Scope,
} from "./scope";
import {
  covers,
  isDirectPrincipalGrant,
  isJsonPrimitive,
  matchesPrincipal,
  narrows,
  principalMatcherNarrows,
} from "./scope";

interface SelectedGrant {
  readonly grant: Grant;
  readonly grantPath: readonly GrantId[];
}

export interface EvaluationResult {
  readonly blockedByDeny?: Restriction;
  readonly blockedByDirectGrant?: Restriction;
  readonly selected?: SelectedGrant;
}

interface AncestorWalkOptions {
  readonly allowExhausted?: boolean;
  readonly invocationId?: string;
  readonly sessionId?: string;
}

export function isExpired(grant: Grant, now: number): boolean {
  return grant.expiresAt !== undefined && grant.expiresAt <= now;
}

export function samePrincipalIdentity(a: Principal, b: Principal): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function restrictionMatchesRequest(
  restriction: Restriction,
  request: AccessRequest
): boolean {
  if (
    restriction.holder !== undefined &&
    !matchesPrincipal(restriction.holder, request.principal, "restrictive")
  ) {
    return false;
  }
  return covers(restriction.scope, request, "restrictive");
}

export function restrictionMatchesGrantPath(
  restriction: Restriction,
  request: AccessRequest,
  grantPath: ReadonlySet<GrantId>
): boolean {
  if (
    restriction.appliesUnder !== undefined &&
    !grantPath.has(restriction.appliesUnder)
  ) {
    return false;
  }
  return restrictionMatchesRequest(restriction, request);
}

export function findBlockingDenyForGrantScope(
  holder: PrincipalMatcher,
  scope: Scope,
  ancestorIds: ReadonlySet<GrantId>,
  restrictions: readonly Restriction[],
  options?: NarrowOptions
): Restriction | undefined {
  return restrictions.find(
    (restriction) =>
      restriction.kind === "deny" &&
      (restriction.appliesUnder === undefined ||
        ancestorIds.has(restriction.appliesUnder)) &&
      (restriction.holder === undefined ||
        principalMatcherNarrows(holder, restriction.holder)) &&
      narrows(scope, restriction.scope, options)
  );
}

export function walkDelegationAncestors(
  startIds: readonly GrantId[],
  grantMap: ReadonlyMap<GrantId, Grant>,
  now: number,
  options: AncestorWalkOptions = {},
  seedId?: GrantId
): readonly GrantId[] | null {
  const ordered: GrantId[] = seedId === undefined ? [] : [seedId];
  const visited = new Set<GrantId>(ordered);
  const visiting = new Set<GrantId>(ordered);

  const walk = (ids: readonly GrantId[]): boolean => {
    for (const id of ids) {
      if (visiting.has(id)) {
        return false;
      }
      if (visited.has(id)) {
        continue;
      }
      const grant = grantMap.get(id);
      if (!isValidDelegationAncestor(grant, now, options)) {
        return false;
      }
      visiting.add(id);
      visited.add(id);
      ordered.push(id);
      if (!walk(grant.parentIds)) {
        return false;
      }
      visiting.delete(id);
    }
    return true;
  };

  return walk(startIds) ? ordered : null;
}

export function evaluateRequestAgainstGrants(
  request: AccessRequest,
  grants: readonly Grant[],
  restrictions: readonly Restriction[],
  now: number,
  invocationId?: string
): EvaluationResult {
  const globalDeny = restrictions.find(
    (restriction) =>
      restriction.kind === "deny" &&
      restriction.appliesUnder === undefined &&
      restrictionMatchesRequest(restriction, request)
  );
  if (globalDeny !== undefined) {
    return { blockedByDeny: globalDeny };
  }

  const effectiveInvocationId = invocationId ?? request.invocationId;
  const grantMap = new Map(grants.map((grant) => [grant.id, grant]));
  const candidates: SelectedGrant[] = [];
  let blockedByDeny: Restriction | undefined;
  let blockedByDirectGrant = restrictions.find(
    (restriction) =>
      restriction.kind === "require-direct-grant" &&
      restriction.appliesUnder === undefined &&
      restrictionMatchesRequest(restriction, request)
  );

  for (const grant of grants) {
    const validated = validateCandidateGrant(
      grant,
      request,
      grantMap,
      restrictions,
      now,
      { invocationId: effectiveInvocationId }
    );
    if (validated.grantPath !== undefined) {
      candidates.push({ grant, grantPath: validated.grantPath });
    } else if (validated.blockedByDeny !== undefined) {
      blockedByDeny ??= validated.blockedByDeny;
    } else if (validated.blockedByDirectGrant !== undefined) {
      blockedByDirectGrant ??= validated.blockedByDirectGrant;
    }
  }

  if (candidates.length === 0) {
    return {
      ...(blockedByDeny === undefined ? {} : { blockedByDeny }),
      ...(blockedByDirectGrant === undefined ? {} : { blockedByDirectGrant }),
    };
  }

  candidates.sort((left, right) =>
    compareCandidates(
      left.grant,
      right.grant,
      request.principal,
      effectiveInvocationId
    )
  );
  return { selected: candidates[0] };
}

export function validateGrantForReplay(
  grant: Grant,
  request: AccessRequest,
  grants: readonly Grant[],
  restrictions: readonly Restriction[],
  now: number,
  invocationId: string
): readonly GrantId[] | null {
  const grantMap = new Map(grants.map((item) => [item.id, item]));
  const validated = validateCandidateGrant(
    grant,
    request,
    grantMap,
    restrictions,
    now,
    { allowExhausted: true, invocationId }
  );
  return validated.grantPath ?? null;
}

export function scopeFromRequest(request: AccessRequest): Scope | null {
  const constraints: Record<string, ConstraintBound> = {};
  let hasConstraints = false;
  if (request.attributes !== undefined) {
    for (const [key, value] of Object.entries(request.attributes)) {
      if (!isJsonPrimitive(value)) {
        if (request.constraintsDigest === undefined) {
          return null;
        }
        continue;
      }
      Object.defineProperty(constraints, key, {
        configurable: true,
        enumerable: true,
        value: { op: "eq", value },
        writable: true,
      });
      hasConstraints = true;
    }
  }
  return {
    action: request.action,
    ...(hasConstraints ? { constraints } : {}),
    ...(request.constraintsDigest === undefined
      ? {}
      : { constraintsDigest: request.constraintsDigest }),
    target: { kind: "exact", value: request.target },
  };
}

interface CandidateValidation {
  readonly blockedByDeny?: Restriction;
  readonly blockedByDirectGrant?: Restriction;
  readonly grantPath?: readonly GrantId[];
}

function validateCandidateGrant(
  grant: Grant,
  request: AccessRequest,
  grantMap: ReadonlyMap<GrantId, Grant>,
  restrictions: readonly Restriction[],
  now: number,
  options: {
    readonly allowExhausted?: boolean;
    readonly invocationId?: string;
  }
): CandidateValidation {
  if (!grantCoversRequest(grant, request, now, options)) {
    return {};
  }
  const grantPath = walkDelegationAncestors(
    grant.parentIds,
    grantMap,
    now,
    {
      allowExhausted: options.allowExhausted,
      invocationId: options.invocationId,
      sessionId: request.sessionId,
    },
    grant.id
  );
  if (grantPath === null) {
    return {};
  }
  const pathSet = new Set(grantPath);
  const pathDeny = findPathRestriction(restrictions, "deny", request, pathSet);
  if (pathDeny !== undefined) {
    return { blockedByDeny: pathDeny };
  }
  const directRequirement = findPathRestriction(
    restrictions,
    "require-direct-grant",
    request,
    pathSet
  );
  if (
    directRequirement !== undefined &&
    !isDirectPrincipalGrant(grant.holder, request.principal)
  ) {
    return { blockedByDirectGrant: directRequirement };
  }
  return { grantPath };
}

function isValidDelegationAncestor(
  grant: Grant | undefined,
  now: number,
  options: AncestorWalkOptions
): grant is Grant {
  if (grant === undefined || !grant.canDelegate || isExpired(grant, now)) {
    return false;
  }
  const validState =
    grant.state === "active" ||
    (options.allowExhausted === true && grant.state === "exhausted");
  if (!validState) {
    return false;
  }
  if (
    options.allowExhausted !== true &&
    grant.usesRemaining !== undefined &&
    grant.usesRemaining <= 0
  ) {
    return false;
  }
  if (grant.sessionId !== undefined && grant.sessionId !== options.sessionId) {
    return false;
  }
  if (
    grant.invocationId !== undefined &&
    grant.invocationId !== options.invocationId
  ) {
    return false;
  }
  return true;
}

function grantCoversRequest(
  grant: Grant,
  request: AccessRequest,
  now: number,
  options: {
    readonly allowExhausted?: boolean;
    readonly invocationId?: string;
  }
): boolean {
  const validState =
    grant.state === "active" ||
    (options.allowExhausted === true && grant.state === "exhausted");
  if (!validState || isExpired(grant, now)) {
    return false;
  }
  if (
    options.allowExhausted !== true &&
    grant.usesRemaining !== undefined &&
    grant.usesRemaining <= 0
  ) {
    return false;
  }
  if (grant.sessionId !== undefined && grant.sessionId !== request.sessionId) {
    return false;
  }
  if (
    grant.invocationId !== undefined &&
    grant.invocationId !== options.invocationId
  ) {
    return false;
  }
  if (!matchesPrincipal(grant.holder, request.principal, "allow")) {
    return false;
  }
  return covers(grant.scope, request, "allow");
}

function findPathRestriction(
  restrictions: readonly Restriction[],
  kind: Restriction["kind"],
  request: AccessRequest,
  pathSet: ReadonlySet<GrantId>
): Restriction | undefined {
  return restrictions.find(
    (restriction) =>
      restriction.kind === kind &&
      restrictionMatchesGrantPath(restriction, request, pathSet)
  );
}

function compareCandidates(
  left: Grant,
  right: Grant,
  principal: Principal,
  invocationId: string | undefined
): number {
  const leftReusable = left.usesRemaining === undefined ? 0 : 1;
  const rightReusable = right.usesRemaining === undefined ? 0 : 1;
  if (leftReusable !== rightReusable) {
    return leftReusable - rightReusable;
  }
  if (invocationId !== undefined) {
    const leftBound = left.invocationId === invocationId ? 0 : 1;
    const rightBound = right.invocationId === invocationId ? 0 : 1;
    if (leftBound !== rightBound) {
      return leftBound - rightBound;
    }
  }
  const leftDirect = isDirectPrincipalGrant(left.holder, principal) ? 0 : 1;
  const rightDirect = isDirectPrincipalGrant(right.holder, principal) ? 0 : 1;
  if (leftDirect !== rightDirect) {
    return leftDirect - rightDirect;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}
