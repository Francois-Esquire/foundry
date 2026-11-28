import {
  AuthorizationNotFoundError,
  AuthorizationRevisionError,
} from "./errors";
import type { Grant, GrantId, RevocationTarget } from "./schema";
import type { AuthorizationStore } from "./store/index";

export function uniqueIds(ids: readonly GrantId[]): readonly GrantId[] {
  return [...new Set(ids)];
}

export async function loadGrantsWithAncestors(
  view: AuthorizationStore,
  seeds: readonly Grant[]
): Promise<readonly Grant[]> {
  const byId = new Map<GrantId, Grant>();
  const queue: GrantId[] = [];
  for (const grant of seeds) {
    byId.set(grant.id, grant);
    for (const parentId of grant.parentIds) {
      if (!byId.has(parentId)) {
        queue.push(parentId);
      }
    }
  }
  await fetchMissingAncestors(view, byId, queue);
  return [...byId.values()];
}

export async function loadAncestorMapByIds(
  view: AuthorizationStore,
  ids: readonly GrantId[]
): Promise<Map<GrantId, Grant>> {
  const byId = new Map<GrantId, Grant>();
  await fetchMissingAncestors(view, byId, [...ids]);
  return byId;
}

async function fetchMissingAncestors(
  view: AuthorizationStore,
  byId: Map<GrantId, Grant>,
  initialQueue: GrantId[]
): Promise<void> {
  const seen = new Set<GrantId>(byId.keys());
  let frontier = initialQueue.filter((id) => !seen.has(id));
  while (frontier.length > 0) {
    const batch = uniqueIds(frontier);
    for (const id of batch) {
      seen.add(id);
    }
    const fetched = await Promise.all(batch.map((id) => view.getGrant(id)));
    const nextFrontier: GrantId[] = [];
    for (const grant of fetched) {
      if (grant === null) {
        continue;
      }
      byId.set(grant.id, grant);
      for (const parentId of grant.parentIds) {
        if (!seen.has(parentId)) {
          nextFrontier.push(parentId);
        }
      }
    }
    frontier = nextFrontier;
  }
}

export async function selectRevocationTargets(
  view: AuthorizationStore,
  target: RevocationTarget
): Promise<readonly Grant[]> {
  if (target.kind === "grant") {
    const grant = await view.getGrant(target.grantId);
    if (grant === null) {
      throw new AuthorizationNotFoundError("grant", target.grantId);
    }
    if (
      target.expectedRevision !== undefined &&
      grant.revision !== target.expectedRevision
    ) {
      throw new AuthorizationRevisionError(
        grant.id,
        target.expectedRevision,
        grant.revision
      );
    }
    return isRevocableState(grant.state) ? [grant] : [];
  }
  if (target.kind === "issuance") {
    const grants = await view.listGrants({ issuanceKey: target.issuanceKey });
    return grants.filter((grant) => isRevocableState(grant.state));
  }
  if (target.kind === "session") {
    const grants = await view.listGrants({ sessionId: target.sessionId });
    return grants.filter((grant) => isRevocableState(grant.state));
  }
  const grants = await view.listGrants();
  return grants.filter(
    (grant) =>
      isRevocableState(grant.state) &&
      grant.holder.kind === "exact" &&
      grant.holder.principal.kind === target.principal.kind &&
      grant.holder.principal.id === target.principal.id &&
      (target.principal.version === undefined ||
        grant.holder.principal.version === target.principal.version)
  );
}

function isRevocableState(state: Grant["state"]): boolean {
  return state !== "revoked" && state !== "denied";
}
