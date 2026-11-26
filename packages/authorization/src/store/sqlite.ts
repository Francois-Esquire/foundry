import {
  assertScope,
  batches,
  describeNumber,
  replacing,
  SQLITE_MAX_PARAMETERS,
  type SqliteDatabase,
  type SqliteTransaction,
  storableNumber,
  storableText,
  UNSTORABLE_TEXT,
} from "@foundry/lib/sqlite";
import { Turns } from "@foundry/lib/turns";
import type { SQL } from "drizzle-orm";
import { and, asc, eq, getTableColumns, inArray, is, max } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
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
import {
  authorizationClaims,
  authorizationGrants,
  authorizationRestrictions,
} from "./tables";

export type AuthorizationDatabase = SqliteDatabase;

export type AuthorizationTransaction = SqliteTransaction;

export interface SqliteAuthorizationStoreOptions {
  readonly database: AuthorizationDatabase;
  readonly durability?: AuthorizationStoreDurability;
  readonly onCommit?: (
    transaction: AuthorizationTransaction,
    write: AuthorizationStoreWrite
  ) => Promise<void>;
  readonly scope: string;
}

const REENTRY =
  "SqliteAuthorizationStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

const {
  position: _grantPosition,
  scope: _grantScope,
  ...grantUpdateColumns
} = getTableColumns(authorizationGrants);

const {
  position: _restrictionPosition,
  scope: _restrictionScope,
  ...restrictionUpdateColumns
} = getTableColumns(authorizationRestrictions);

const { scope: _claimScope, ...claimUpdateColumns } =
  getTableColumns(authorizationClaims);

const replaceGrant = replacing(grantUpdateColumns);
const replaceRestriction = replacing(restrictionUpdateColumns);
const replaceClaim = replacing(claimUpdateColumns);

type GrantRow = typeof authorizationGrants.$inferInsert;
type RestrictionRow = typeof authorizationRestrictions.$inferInsert;
type ClaimRow = typeof authorizationClaims.$inferInsert;

export class SqliteAuthorizationStore implements AuthorizationStore {
  readonly durability: AuthorizationStoreDurability;
  readonly #database: AuthorizationDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteAuthorizationStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteAuthorizationStoreOptions) {
    assertScope(options.scope);
    const joined = is(options.database, SQLiteTransaction);
    if (joined && options.durability === "commit") {
      throw new RangeError(
        'database is a transaction the host owns, which it may roll back: a commit is durable only when the host\'s is, so durability cannot be "commit"'
      );
    }
    this.durability = joined ? "host" : (options.durability ?? "commit");
    this.#database = options.database;
    this.#scope = options.scope;
    this.#onCommit = options.onCommit;
  }

  commit(write: AuthorizationStoreWrite): Promise<void> {
    let owned: AuthorizationStoreWrite;
    let rows: PreparedRows;
    try {
      owned = structuredClone(write);
      rows = prepareRows(owned);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        await this.#deleteByKey(
          transaction,
          authorizationGrants,
          authorizationGrants.id,
          owned.deleteGrants ?? []
        );
        await this.#deleteByKey(
          transaction,
          authorizationRestrictions,
          authorizationRestrictions.id,
          owned.deleteRestrictions ?? []
        );
        await this.#deleteByKey(
          transaction,
          authorizationClaims,
          authorizationClaims.invocationId,
          owned.deleteClaims ?? []
        );
        await this.#putGrants(transaction, rows.grants);
        await this.#putRestrictions(transaction, rows.restrictions);
        await this.#putClaims(transaction, rows.claims);
        await this.#onCommit?.(transaction, owned);
      })
    );
  }

  transaction<T>(work: (view: AuthorizationStore) => Promise<T>): Promise<T> {
    return this.#turns.run(() =>
      this.#database.transaction((transaction) =>
        work(
          new SqliteAuthorizationStore({
            database: transaction,
            scope: this.#scope,
            ...(this.#onCommit === undefined
              ? {}
              : { onCommit: this.#onCommit }),
          })
        )
      )
    );
  }

  getGrant(id: GrantId): Promise<Grant | null> {
    return this.#turns.run(async () => {
      if (!storableText(id)) {
        return null;
      }
      const [row] = await this.#database
        .select({ record: authorizationGrants.record })
        .from(authorizationGrants)
        .where(
          and(
            eq(authorizationGrants.scope, this.#scope),
            eq(authorizationGrants.id, id)
          )
        );
      return row === undefined ? null : structuredClone(row.record);
    });
  }

  listGrants(query?: GrantQuery): Promise<readonly Grant[]> {
    let owned: GrantQuery | undefined;
    try {
      owned = query === undefined ? undefined : structuredClone(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(async () => {
      const conditions = this.#grantConditions(owned);
      if (conditions === null) {
        return [];
      }
      const rows = await this.#database
        .select({ record: authorizationGrants.record })
        .from(authorizationGrants)
        .where(and(...conditions))
        .orderBy(asc(authorizationGrants.position));
      return rows
        .map((row) => row.record)
        .filter((grant) => matchesGrantQuery(grant, owned))
        .map((grant) => structuredClone(grant));
    });
  }

  getRestriction(id: RestrictionId): Promise<Restriction | null> {
    return this.#turns.run(async () => {
      if (!storableText(id)) {
        return null;
      }
      const [row] = await this.#database
        .select({ record: authorizationRestrictions.record })
        .from(authorizationRestrictions)
        .where(
          and(
            eq(authorizationRestrictions.scope, this.#scope),
            eq(authorizationRestrictions.id, id)
          )
        );
      return row === undefined ? null : structuredClone(row.record);
    });
  }

  listRestrictions(): Promise<readonly Restriction[]> {
    return this.#turns.run(async () => {
      const rows = await this.#database
        .select({ record: authorizationRestrictions.record })
        .from(authorizationRestrictions)
        .where(eq(authorizationRestrictions.scope, this.#scope))
        .orderBy(asc(authorizationRestrictions.position));
      return rows.map((row) => structuredClone(row.record));
    });
  }

  getClaim(invocationId: string): Promise<InvocationClaim | null> {
    return this.#turns.run(async () => {
      if (!storableText(invocationId)) {
        return null;
      }
      const [row] = await this.#database
        .select({
          claimedAt: authorizationClaims.claimedAt,
          grantId: authorizationClaims.grantId,
          invocationId: authorizationClaims.invocationId,
          releasedAt: authorizationClaims.releasedAt,
        })
        .from(authorizationClaims)
        .where(
          and(
            eq(authorizationClaims.scope, this.#scope),
            eq(authorizationClaims.invocationId, invocationId)
          )
        );
      if (row === undefined) {
        return null;
      }
      return {
        claimedAt: row.claimedAt,
        grantId: row.grantId,
        invocationId: row.invocationId,
        ...(row.releasedAt === null ? {} : { releasedAt: row.releasedAt }),
      };
    });
  }

  #grantConditions(query: GrantQuery | undefined): SQL[] | null {
    const conditions: SQL[] = [eq(authorizationGrants.scope, this.#scope)];
    if (query === undefined) {
      return conditions;
    }
    if (query.state !== undefined) {
      if (typeof query.state === "string") {
        conditions.push(eq(authorizationGrants.state, query.state));
      } else {
        if (query.state.length === 0) {
          return null;
        }
        conditions.push(inArray(authorizationGrants.state, [...query.state]));
      }
    }
    if (
      !(
        appendTextCondition(
          conditions,
          authorizationGrants.action,
          query.action
        ) &&
        appendTextCondition(
          conditions,
          authorizationGrants.sessionId,
          query.sessionId
        ) &&
        appendTextCondition(
          conditions,
          authorizationGrants.issuanceKey,
          query.issuanceKey
        ) &&
        appendTextCondition(
          conditions,
          authorizationGrants.invocationId,
          query.invocationId
        )
      )
    ) {
      return null;
    }
    return conditions;
  }

  async #deleteByKey(
    transaction: AuthorizationTransaction,
    table:
      | typeof authorizationClaims
      | typeof authorizationGrants
      | typeof authorizationRestrictions,
    keyColumn: SQLiteColumn,
    keys: readonly string[]
  ): Promise<void> {
    for (const batch of batches(
      keys.filter(storableText),
      SQLITE_MAX_PARAMETERS - 1
    )) {
      await transaction
        .delete(table)
        .where(and(eq(table.scope, this.#scope), inArray(keyColumn, batch)));
    }
  }

  async #putGrants(
    transaction: AuthorizationTransaction,
    records: readonly Omit<GrantRow, "position" | "scope">[]
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const columns = Object.keys(getTableColumns(authorizationGrants)).length;
    const first = await this.#nextPosition(transaction, authorizationGrants);
    const rows = records.map((record, index) => ({
      ...record,
      position: first + index,
      scope: this.#scope,
    }));
    for (const batch of batches(rows, SQLITE_MAX_PARAMETERS / columns)) {
      await transaction
        .insert(authorizationGrants)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceGrant,
          target: [authorizationGrants.scope, authorizationGrants.id],
        });
    }
  }

  async #putRestrictions(
    transaction: AuthorizationTransaction,
    records: readonly Omit<RestrictionRow, "position" | "scope">[]
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const columns = Object.keys(
      getTableColumns(authorizationRestrictions)
    ).length;
    const first = await this.#nextPosition(
      transaction,
      authorizationRestrictions
    );
    const rows = records.map((record, index) => ({
      ...record,
      position: first + index,
      scope: this.#scope,
    }));
    for (const batch of batches(rows, SQLITE_MAX_PARAMETERS / columns)) {
      await transaction
        .insert(authorizationRestrictions)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceRestriction,
          target: [
            authorizationRestrictions.scope,
            authorizationRestrictions.id,
          ],
        });
    }
  }

  async #putClaims(
    transaction: AuthorizationTransaction,
    records: readonly Omit<ClaimRow, "scope">[]
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const columns = Object.keys(getTableColumns(authorizationClaims)).length;
    const rows = records.map((record) => ({
      ...record,
      scope: this.#scope,
    }));
    for (const batch of batches(rows, SQLITE_MAX_PARAMETERS / columns)) {
      await transaction
        .insert(authorizationClaims)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceClaim,
          target: [authorizationClaims.scope, authorizationClaims.invocationId],
        });
    }
  }

  async #nextPosition(
    transaction: AuthorizationTransaction,
    table: typeof authorizationGrants | typeof authorizationRestrictions
  ): Promise<number> {
    const [last] = await transaction
      .select({ position: max(table.position) })
      .from(table)
      .where(eq(table.scope, this.#scope));
    return (last?.position ?? 0) + 1;
  }
}

interface PreparedRows {
  readonly claims: readonly Omit<ClaimRow, "scope">[];
  readonly grants: readonly Omit<GrantRow, "position" | "scope">[];
  readonly restrictions: readonly Omit<RestrictionRow, "position" | "scope">[];
}

function appendTextCondition(
  conditions: SQL[],
  column: SQLiteColumn,
  value: string | undefined
): boolean {
  if (value === undefined) {
    return true;
  }
  if (!storableText(value)) {
    return false;
  }
  conditions.push(eq(column, value));
  return true;
}

function prepareRows(write: AuthorizationStoreWrite): PreparedRows {
  return {
    claims: (write.putClaims ?? []).map((claim, index) =>
      prepareClaimRow(claim, `putClaims[${index}]`)
    ),
    grants: (write.putGrants ?? []).map((grant, index) =>
      prepareGrantRow(grant, `putGrants[${index}]`)
    ),
    restrictions: (write.putRestrictions ?? []).map((restriction, index) =>
      prepareRestrictionRow(restriction, `putRestrictions[${index}]`)
    ),
  };
}

function prepareGrantRow(
  grant: Grant,
  at: string
): Omit<GrantRow, "position" | "scope"> {
  checkJson(grant, at, new Set());
  return {
    action: requireText(grant.scope.action, `${at}.scope.action`),
    createdAt: requireInteger(grant.createdAt, `${at}.createdAt`),
    id: requireText(grant.id, `${at}.id`),
    invocationId:
      grant.invocationId === undefined
        ? null
        : requireText(grant.invocationId, `${at}.invocationId`),
    issuanceKey:
      grant.issuanceKey === undefined
        ? null
        : requireText(grant.issuanceKey, `${at}.issuanceKey`),
    record: grant,
    revision: requireInteger(grant.revision, `${at}.revision`),
    sessionId:
      grant.sessionId === undefined
        ? null
        : requireText(grant.sessionId, `${at}.sessionId`),
    state: requireText(grant.state, `${at}.state`),
    updatedAt: requireInteger(grant.updatedAt, `${at}.updatedAt`),
  };
}

function prepareRestrictionRow(
  restriction: Restriction,
  at: string
): Omit<RestrictionRow, "position" | "scope"> {
  checkJson(restriction, at, new Set());
  return {
    action: requireText(restriction.scope.action, `${at}.scope.action`),
    appliesUnder:
      restriction.appliesUnder === undefined
        ? null
        : requireText(restriction.appliesUnder, `${at}.appliesUnder`),
    createdAt: requireInteger(restriction.createdAt, `${at}.createdAt`),
    id: requireText(restriction.id, `${at}.id`),
    kind: requireText(restriction.kind, `${at}.kind`),
    record: restriction,
    revision: requireInteger(restriction.revision, `${at}.revision`),
    updatedAt: requireInteger(restriction.updatedAt, `${at}.updatedAt`),
  };
}

function prepareClaimRow(
  claim: InvocationClaim,
  at: string
): Omit<ClaimRow, "scope"> {
  return {
    claimedAt: requireInteger(claim.claimedAt, `${at}.claimedAt`),
    grantId: requireText(claim.grantId, `${at}.grantId`),
    invocationId: requireText(claim.invocationId, `${at}.invocationId`),
    releasedAt:
      claim.releasedAt === undefined
        ? null
        : requireInteger(claim.releasedAt, `${at}.releasedAt`),
  };
}

function unstorable(field: string, reason: string): RangeError {
  return new RangeError(
    `SqliteAuthorizationStore cannot store ${field}: ${reason}`
  );
}

function requireText<T extends string>(value: T, field: string): T {
  if (typeof value !== "string") {
    throw unstorable(field, `value of type ${typeof value} is not text`);
  }
  if (!storableText(value)) {
    throw unstorable(field, UNSTORABLE_TEXT);
  }
  return value;
}

function requireInteger(value: number, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    !storableNumber(value)
  ) {
    throw unstorable(
      field,
      `${describeNumber(value)} must be a safe integer other than -0`
    );
  }
  return value;
}

function checkJson(value: unknown, at: string, ancestors: Set<object>): void {
  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw unstorable(
          at,
          `${describeNumber(value)} does not read back intact from JSON`
        );
      }
      return;
    case "object":
      if (value === null) {
        return;
      }
      checkComposite(value, at, ancestors);
      return;
    default:
      throw unstorable(at, `value of type ${typeof value} has no JSON form`);
  }
}

function checkComposite(
  value: object,
  at: string,
  ancestors: Set<object>
): void {
  if (ancestors.has(value)) {
    throw unstorable(at, "circular structure has no JSON form");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw unstorable(`${at}[${index}]`, "sparse array hole");
        }
        checkJson(value[index], `${at}[${index}]`, ancestors);
      }
      return;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw unstorable(at, "non-plain object has no JSON form");
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        throw unstorable(`${at}.${key}`, "property holding undefined");
      }
      checkJson(item, `${at}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}
