import { Turns } from "@foundry/lib/turns";
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
    let owned: OwnedWrite;
    try {
      owned = captureWrite(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() => {
      this.#tables = this.#tables.applied(owned);
      return Promise.resolve();
    });
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
    return this.#turns.run(() => Promise.resolve(this.#tables.getGrant(id)));
  }

  listGrants(query?: GrantQuery): Promise<readonly Grant[]> {
    let owned: GrantQuery | undefined;
    try {
      owned = query === undefined ? undefined : structuredClone(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() =>
      Promise.resolve(this.#tables.listGrants(owned))
    );
  }

  getRestriction(id: RestrictionId): Promise<Restriction | null> {
    return this.#turns.run(() =>
      Promise.resolve(this.#tables.getRestriction(id))
    );
  }

  listRestrictions(): Promise<readonly Restriction[]> {
    return this.#turns.run(() =>
      Promise.resolve(this.#tables.listRestrictions())
    );
  }

  getClaim(invocationId: string): Promise<InvocationClaim | null> {
    return this.#turns.run(() =>
      Promise.resolve(this.#tables.getClaim(invocationId))
    );
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
    let owned: OwnedWrite;
    try {
      owned = captureWrite(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run(() => {
      this.tables = this.tables.applied(owned);
    });
  }

  getGrant(id: GrantId): Promise<Grant | null> {
    return this.#run(() => this.tables.getGrant(id));
  }

  listGrants(query?: GrantQuery): Promise<readonly Grant[]> {
    let owned: GrantQuery | undefined;
    try {
      owned = query === undefined ? undefined : structuredClone(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run(() => this.tables.listGrants(owned));
  }

  getRestriction(id: RestrictionId): Promise<Restriction | null> {
    return this.#run(() => this.tables.getRestriction(id));
  }

  listRestrictions(): Promise<readonly Restriction[]> {
    return this.#run(() => this.tables.listRestrictions());
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
  readonly deleteClaims: readonly string[];
  readonly deleteGrants: readonly GrantId[];
  readonly deleteRestrictions: readonly RestrictionId[];
  readonly putClaims: readonly InvocationClaim[];
  readonly putGrants: readonly Grant[];
  readonly putRestrictions: readonly Restriction[];
}

function captureWrite(write: AuthorizationStoreWrite): OwnedWrite {
  const copy = structuredClone(write);
  return {
    deleteClaims: copy.deleteClaims ?? [],
    deleteGrants: copy.deleteGrants ?? [],
    deleteRestrictions: copy.deleteRestrictions ?? [],
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

  listRestrictions(): readonly Restriction[] {
    return [...this.restrictions.values()].map((restriction) =>
      structuredClone(restriction)
    );
  }

  getClaim(invocationId: string): InvocationClaim | null {
    const claim = this.claims.get(invocationId);
    return claim === undefined ? null : structuredClone(claim);
  }

  applied(write: OwnedWrite): StoreTables {
    const next = new StoreTables(this);
    for (const id of write.deleteGrants) {
      next.grants.delete(id);
    }
    for (const id of write.deleteRestrictions) {
      next.restrictions.delete(id);
    }
    for (const invocationId of write.deleteClaims) {
      next.claims.delete(invocationId);
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
