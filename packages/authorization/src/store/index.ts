import type {
  Grant,
  GrantId,
  GrantQuery,
  InvocationClaim,
  Restriction,
  RestrictionId,
} from "../schema";

export type {
  Grant,
  GrantId,
  GrantQuery,
  InvocationClaim,
  Restriction,
  RestrictionId,
} from "../schema";

export type AuthorizationStoreDurability = "commit" | "host";

export interface RestrictionQuery {
  readonly action?: string;
}

export interface AuthorizationStoreWrite {
  readonly createClaims?: readonly InvocationClaim[];
  readonly deleteClaims?: readonly string[];
  readonly deleteGrants?: readonly GrantId[];
  readonly deleteRestrictions?: readonly RestrictionId[];
  readonly expectedGrantRevisions?: Readonly<Record<GrantId, number>>;
  readonly putClaims?: readonly InvocationClaim[];
  readonly putGrants?: readonly Grant[];
  readonly putRestrictions?: readonly Restriction[];
}

export interface AuthorizationStore {
  commit(write: AuthorizationStoreWrite): Promise<void>;
  readonly durability?: AuthorizationStoreDurability;
  getClaim(invocationId: string): Promise<InvocationClaim | null>;
  getGrant(id: GrantId): Promise<Grant | null>;
  getRestriction(id: RestrictionId): Promise<Restriction | null>;
  listGrants(query?: GrantQuery): Promise<readonly Grant[]>;
  listRestrictions(query?: RestrictionQuery): Promise<readonly Restriction[]>;
  transaction?<T>(work: (view: AuthorizationStore) => Promise<T>): Promise<T>;
}
