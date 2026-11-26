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
  for (const restriction of restrictions) {
    if (restriction.kind !== "deny") {
      continue;
    }
    if (
      restriction.appliesUnder !== undefined &&
      !ancestorIds.has(restriction.appliesUnder)
    ) {
      continue;
    }
    if (
      restriction.holder !== undefined &&
      !principalMatcherNarrows(holder, restriction.holder)
    ) {
      continue;
    }
    if (narrows(scope, restriction.scope, options)) {
      return restriction;
    }
  }
  return undefined;
}

function findGlobalDeny(
  restrictions: readonly Restriction[],
  request: AccessRequest
): Restriction | undefined {
  return restrictions.find(
    (restriction) =>
      restriction.kind === "deny" &&
      restriction.appliesUnder === undefined &&
      restrictionMatchesRequest(restriction, request)
  );
}

function findGlobalDirectGrantRequirement(
  restrictions: readonly Restriction[],
  request: AccessRequest
): Restriction | undefined {
  return restrictions.find(
    (restriction) =>
      restriction.kind === "require-direct-grant" &&
      restriction.appliesUnder === undefined &&
      restrictionMatchesRequest(restriction, request)
  );
}

function resolveActiveAncestorPath(
  rootGrant: Grant,
  grantMap: ReadonlyMap<GrantId, Grant>,
  now: number,
  sessionId: string | undefined
): readonly GrantId[] | null {
  const ordered: GrantId[] = [rootGrant.id];
  const visited = new Set<GrantId>([rootGrant.id]);
  const visiting = new Set<GrantId>([rootGrant.id]);

  const walk = (parentIds: readonly GrantId[]): boolean => {
    for (const parentId of parentIds) {
      if (visiting.has(parentId)) {
        return false;
      }
      if (visited.has(parentId)) {
        continue;
      }
      const parent = grantMap.get(parentId);
      if (!isValidDelegationAncestor(parent, now, sessionId)) {
        return false;
      }
      visiting.add(parentId);
      visited.add(parentId);
      ordered.push(parentId);
      if (!walk(parent.parentIds)) {
        return false;
      }
      visiting.delete(parentId);
    }
    return true;
  };

  return walk(rootGrant.parentIds) ? ordered : null;
}

export function collectDelegationAncestors(
  parentIds: readonly GrantId[],
  grantMap: ReadonlyMap<GrantId, Grant>,
  now: number
): ReadonlySet<GrantId> | null {
  const visited = new Set<GrantId>();
  const visiting = new Set<GrantId>();

  const walk = (ids: readonly GrantId[]): boolean => {
    for (const id of ids) {
      if (visiting.has(id)) {
        return false;
      }
      if (visited.has(id)) {
        continue;
      }
      const grant = grantMap.get(id);
      if (
        grant === undefined ||
        grant.state !== "active" ||
        !grant.canDelegate ||
        isExpired(grant, now)
      ) {
        return false;
      }
      visiting.add(id);
      visited.add(id);
      if (!walk(grant.parentIds)) {
        return false;
      }
      visiting.delete(id);
    }
    return true;
  };

  return walk(parentIds) ? visited : null;
}

export function evaluateRequestAgainstGrants(
  request: AccessRequest,
  grants: readonly Grant[],
  restrictions: readonly Restriction[],
  now: number,
  invocationId?: string
): EvaluationResult {
  const globalDeny = findGlobalDeny(restrictions, request);
  if (globalDeny !== undefined) {
    return { blockedByDeny: globalDeny };
  }

  const grantMap = new Map(grants.map((grant) => [grant.id, grant]));
  const candidates: SelectedGrant[] = [];
  let blockedByDeny: Restriction | undefined;
  let blockedByDirectGrant = findGlobalDirectGrantRequirement(
    restrictions,
    request
  );

  for (const grant of grants) {
    if (!grantCoversRequest(grant, request, now)) {
      continue;
    }
    const grantPath = resolveActiveAncestorPath(
      grant,
      grantMap,
      now,
      request.sessionId
    );
    if (grantPath === null) {
      continue;
    }
    const pathSet = new Set(grantPath);
    const pathDeny = findPathRestriction(
      restrictions,
      "deny",
      request,
      pathSet
    );
    if (pathDeny !== undefined) {
      blockedByDeny ??= pathDeny;
      continue;
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
      blockedByDirectGrant ??= directRequirement;
      continue;
    }
    candidates.push({ grant, grantPath });
  }

  if (candidates.length === 0) {
    return {
      ...(blockedByDeny === undefined ? {} : { blockedByDeny }),
      ...(blockedByDirectGrant === undefined ? {} : { blockedByDirectGrant }),
    };
  }

  candidates.sort((left, right) =>
    compareCandidates(left.grant, right.grant, request.principal, invocationId)
  );
  return { selected: candidates[0] };
}

export function grantCoversRequestForReplay(
  grant: Grant,
  request: AccessRequest,
  grants: readonly Grant[],
  restrictions: readonly Restriction[],
  now: number
): readonly GrantId[] | null {
  if (grant.state !== "active" && grant.state !== "exhausted") {
    return null;
  }
  if (isExpired(grant, now)) {
    return null;
  }
  if (grant.sessionId !== undefined && grant.sessionId !== request.sessionId) {
    return null;
  }
  if (!matchesPrincipal(grant.holder, request.principal, "allow")) {
    return null;
  }
  if (!covers(grant.scope, request, "allow")) {
    return null;
  }
  const grantMap = new Map(grants.map((item) => [item.id, item]));
  const grantPath = resolveActiveAncestorPath(
    grant,
    grantMap,
    now,
    request.sessionId
  );
  if (grantPath === null) {
    return null;
  }
  const pathSet = new Set(grantPath);
  if (
    findPathRestriction(restrictions, "deny", request, pathSet) !== undefined
  ) {
    return null;
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
    return null;
  }
  return grantPath;
}

export function scopeFromRequest(request: AccessRequest): Scope {
  const constraints: Record<string, ConstraintBound> = {};
  let hasConstraints = false;
  if (request.attributes !== undefined) {
    for (const [key, value] of Object.entries(request.attributes)) {
      if (isJsonPrimitive(value)) {
        constraints[key] = { op: "eq", value };
        hasConstraints = true;
      }
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

function isValidDelegationAncestor(
  grant: Grant | undefined,
  now: number,
  sessionId: string | undefined
): grant is Grant {
  if (grant === undefined) {
    return false;
  }
  if (grant.state !== "active" || !grant.canDelegate || isExpired(grant, now)) {
    return false;
  }
  if (grant.sessionId !== undefined && grant.sessionId !== sessionId) {
    return false;
  }
  if (grant.usesRemaining !== undefined && grant.usesRemaining <= 0) {
    return false;
  }
  return true;
}

function grantCoversRequest(
  grant: Grant,
  request: AccessRequest,
  now: number
): boolean {
  if (grant.state !== "active" || isExpired(grant, now)) {
    return false;
  }
  if (grant.sessionId !== undefined && grant.sessionId !== request.sessionId) {
    return false;
  }
  if (grant.usesRemaining !== undefined && grant.usesRemaining <= 0) {
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
