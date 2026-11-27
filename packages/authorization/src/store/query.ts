import type { Grant, GrantQuery } from "../schema";
import { matchesPrincipal } from "../scope";

export function matchesGrantQuery(
  grant: Grant,
  query: GrantQuery | undefined
): boolean {
  if (query === undefined) {
    return true;
  }
  if (!matchesStateFilter(grant.state, query.state)) {
    return false;
  }
  if (query.sessionId !== undefined && grant.sessionId !== query.sessionId) {
    return false;
  }
  if (
    query.issuanceKey !== undefined &&
    grant.issuanceKey !== query.issuanceKey
  ) {
    return false;
  }
  if (
    query.invocationId !== undefined &&
    grant.invocationId !== query.invocationId
  ) {
    return false;
  }
  if (query.action !== undefined && grant.scope.action !== query.action) {
    return false;
  }
  if (
    query.parentId !== undefined &&
    !grant.parentIds.includes(query.parentId)
  ) {
    return false;
  }
  if (
    query.principal !== undefined &&
    !matchesPrincipal(grant.holder, query.principal, "allow")
  ) {
    return false;
  }
  return true;
}

function matchesStateFilter(
  state: Grant["state"],
  filter: GrantQuery["state"]
): boolean {
  if (filter === undefined) {
    return true;
  }
  if (Array.isArray(filter)) {
    return filter.includes(state);
  }
  return state === filter;
}
