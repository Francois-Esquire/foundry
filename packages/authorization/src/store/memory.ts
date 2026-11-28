import { Turns } from "@foundry/lib/turns";
import { AuthorizationRevisionError, AuthorizationStateError } from "../errors";
import type {
  Grant,
  GrantId,
  GrantQuery,
  InvocationClaim,
  Restriction,
  RestrictionId,
} from "../schema";
import type {
  AuthorizationStore,
  AuthorizationStoreDurability,
  AuthorizationStoreWrite,
  RestrictionQuery,
} from "./index";
import { matchesGrantQuery } from "./query";

const REENTRY =
  "MemoryAuthorizationStore was called from inside its own transaction; use the view passed to the transaction's work instead";

const ENDED =
  "MemoryAuthorizationStore transaction view was used after its transaction settled";

export class MemoryAuthorizationStore implements AuthorizationStore {
  readonly durability: AuthorizationStoreDurability = "commit";
  #tables = new StoreTables();
  readonly #turns = new Turns(REENTRY);

  commit(write: AuthorizationStoreWrite): Promise<void> {
    return this.transaction((view) => view.commit(write));
  }

  transaction<T>(work: (view: AuthorizationStore) => Promise<T>): Promise<T> {
    return this.#turns.run(async () => {
      const view = new MemoryAuthorizationView(this.#tables);
      try {
        const result = await work(view);
        this.#tables = view.tables;
        return result;
      } finally {
        view.end();
      }
    });
  }

  getGrant(id: GrantId): Promise<Grant | null> {
    return this.transaction((view) => view.getGrant(id));
  }

  listGrants(query?: GrantQuery): Promise<readonly Grant[]> {
    return this.transaction((view) => view.listGrants(query));
  }

  getRestriction(id: RestrictionId): Promise<Restriction | null> {
    return this.transaction((view) => view.getRestriction(id));
  }

  listRestrictions(query?: RestrictionQuery): Promise<readonly Restriction[]> {
    return this.transaction((view) => view.listRestrictions(query));
  }

  getClaim(invocationId: string): Promise<InvocationClaim | null> {
    return this.transaction((view) => view.getClaim(invocationId));
  }
}

class MemoryAuthorizationView implements AuthorizationStore {
  readonly durability: AuthorizationStoreDurability = "host";
  tables: StoreTables;
  #ended: boolean;

  constructor(tables: StoreTables) {
    this.tables = tables;
    this.#ended = false;
  }

  end(): void {
    this.#ended = true;
  }

  commit(write: AuthorizationStoreWrite): Promise<void> {
    return this.#run(() => {
      this.tables = this.tables.applied(captureWrite(write));
    });
  }

  getGrant(id: GrantId): Promise<Grant | null> {
    return this.#run(() => this.tables.getGrant(id));
  }

  listGrants(query?: GrantQuery): Promise<readonly Grant[]> {
    return this.#run(() =>
      this.tables.listGrants(
        query === undefined ? undefined : structuredClone(query)
      )
    );
  }

  getRestriction(id: RestrictionId): Promise<Restriction | null> {
    return this.#run(() => this.tables.getRestriction(id));
  }

  listRestrictions(query?: RestrictionQuery): Promise<readonly Restriction[]> {
    return this.#run(() =>
      this.tables.listRestrictions(
        query === undefined ? undefined : structuredClone(query)
      )
    );
  }

  getClaim(invocationId: string): Promise<InvocationClaim | null> {
    return this.#run(() => this.tables.getClaim(invocationId));
  }

  #run<T>(operation: () => T): Promise<T> {
    if (this.#ended) {
      return Promise.reject(new Error(ENDED));
    }
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

interface OwnedWrite {
  readonly createClaims: readonly InvocationClaim[];
  readonly deleteClaims: readonly string[];
  readonly deleteGrants: readonly GrantId[];
  readonly deleteRestrictions: readonly RestrictionId[];
  readonly expectedGrantRevisions: Readonly<Record<string, number>>;
  readonly putClaims: readonly InvocationClaim[];
  readonly putGrants: readonly Grant[];
  readonly putRestrictions: readonly Restriction[];
}

function captureWrite(write: AuthorizationStoreWrite): OwnedWrite {
  const copy = structuredClone(write);
  return {
    createClaims: copy.createClaims ?? [],
    deleteClaims: copy.deleteClaims ?? [],
    deleteGrants: copy.deleteGrants ?? [],
    deleteRestrictions: copy.deleteRestrictions ?? [],
    expectedGrantRevisions: copy.expectedGrantRevisions ?? {},
    putClaims: copy.putClaims ?? [],
    putGrants: copy.putGrants ?? [],
    putRestrictions: copy.putRestrictions ?? [],
  };
}

class StoreTables {
  readonly claims: Map<string, InvocationClaim>;
  readonly grants: Map<GrantId, Grant>;
  readonly restrictions: Map<RestrictionId, Restriction>;

  constructor(from?: StoreTables) {
    this.grants = new Map(from?.grants);
    this.restrictions = new Map(from?.restrictions);
    this.claims = new Map(from?.claims);
  }

  getGrant(id: GrantId): Grant | null {
    const grant = this.grants.get(id);
    return grant === undefined ? null : structuredClone(grant);
  }

  listGrants(query?: GrantQuery): readonly Grant[] {
    return [...this.grants.values()]
      .filter((grant) => matchesGrantQuery(grant, query))
      .map((grant) => structuredClone(grant));
  }

  getRestriction(id: RestrictionId): Restriction | null {
    const restriction = this.restrictions.get(id);
    return restriction === undefined ? null : structuredClone(restriction);
  }

  listRestrictions(query?: RestrictionQuery): readonly Restriction[] {
    return [...this.restrictions.values()]
      .filter(
        (restriction) =>
          query?.action === undefined ||
          restriction.scope.action === query.action
      )
      .map((restriction) => structuredClone(restriction));
  }

  getClaim(invocationId: string): InvocationClaim | null {
    const claim = this.claims.get(invocationId);
    return claim === undefined ? null : structuredClone(claim);
  }

  applied(write: OwnedWrite): StoreTables {
    for (const [id, expected] of Object.entries(write.expectedGrantRevisions)) {
      const current = this.grants.get(id as GrantId);
      if (current === undefined || current.revision !== expected) {
        throw new AuthorizationRevisionError(
          id as GrantId,
          expected,
          current?.revision ?? null
        );
      }
    }
    const next = new StoreTables(this);
    for (const claim of write.createClaims) {
      if (next.claims.has(claim.invocationId)) {
        throw new AuthorizationStateError(
          `Invocation ${claim.invocationId} has already been claimed`
        );
      }
      next.claims.set(claim.invocationId, claim);
    }
    for (const id of write.deleteClaims) {
      next.claims.delete(id);
    }
    for (const id of write.deleteGrants) {
      next.grants.delete(id);
    }
    for (const id of write.deleteRestrictions) {
      next.restrictions.delete(id);
    }
    for (const grant of write.putGrants) {
      next.grants.set(grant.id, grant);
    }
    for (const restriction of write.putRestrictions) {
      next.restrictions.set(restriction.id, restriction);
    }
    for (const claim of write.putClaims) {
      next.claims.set(claim.invocationId, claim);
    }
    return next;
  }
}
