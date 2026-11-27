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

export interface AuthorizationStoreWrite {
  readonly deleteRestrictions?: readonly RestrictionId[];
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
  listRestrictions(): Promise<readonly Restriction[]>;
  transaction?<T>(work: (view: AuthorizationStore) => Promise<T>): Promise<T>;
}
