import {
  assertScope,
  describeNumber,
  replacing,
  resolveMaxParameters,
  rowBatches,
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
  readonly maxParameters?: number;
  readonly scope: string;
}

const REENTRY =
  "SqliteAuthorizationStore was called from inside its own transaction; use the view passed to the transaction's work instead";

const databaseTurns = new WeakMap<AuthorizationDatabase, Turns>();

function turnsFor(database: AuthorizationDatabase): Turns {
  let turns = databaseTurns.get(database);
  if (turns === undefined) {
    turns = new Turns(REENTRY);
    databaseTurns.set(database, turns);
  }
  return turns;
}

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
  readonly #maxParameters: number;
  readonly #scope: string;
  readonly #turns: Turns;

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
    this.#maxParameters = resolveMaxParameters(options.maxParameters);
    this.#scope = options.scope;
    this.#turns = turnsFor(options.database);
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
        await this.#checkExpectedGrantRevisions(
          transaction,
          owned.expectedGrantRevisions
        );
        await this.#createClaims(transaction, rows.createClaims);
        await this.#deleteClaims(transaction, owned.deleteClaims ?? []);
        await this.#deleteGrants(transaction, owned.deleteGrants ?? []);
        await this.#deleteRestrictions(
          transaction,
          owned.deleteRestrictions ?? []
        );
        await this.#putPositioned(
          transaction,
          authorizationGrants,
          rows.grants,
          replaceGrant
        );
        await this.#putPositioned(
          transaction,
          authorizationRestrictions,
          rows.restrictions,
          replaceRestriction
        );
        await this.#putClaims(transaction, rows.claims);
      })
    );
  }

  transaction<T>(work: (view: AuthorizationStore) => Promise<T>): Promise<T> {
    return this.#turns.run(() =>
      this.#database.transaction((transaction) =>
        work(
          new SqliteAuthorizationStore({
            database: transaction,
            maxParameters: this.#maxParameters,
            scope: this.#scope,
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

  listRestrictions(query?: RestrictionQuery): Promise<readonly Restriction[]> {
    return this.#turns.run(async () => {
      const conditions: SQL[] = [
        eq(authorizationRestrictions.scope, this.#scope),
      ];
      if (
        !appendTextCondition(
          conditions,
          authorizationRestrictions.action,
          query?.action
        )
      ) {
        return [];
      }
      const rows = await this.#database
        .select({ record: authorizationRestrictions.record })
        .from(authorizationRestrictions)
        .where(and(...conditions))
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
          requestFingerprint: authorizationClaims.requestFingerprint,
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
        ...(row.requestFingerprint === null
          ? {}
          : { requestFingerprint: row.requestFingerprint }),
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

  async #checkExpectedGrantRevisions(
    transaction: AuthorizationTransaction,
    expected: Readonly<Record<string, number>> | undefined
  ): Promise<void> {
    if (expected === undefined) {
      return;
    }
    const entries = Object.entries(expected);
    if (entries.length === 0) {
      return;
    }
    const ids = entries.map(([id]) => id as GrantId).filter(storableText);
    const actualById = new Map<string, number>();
    for (const batch of rowBatches(ids, 1, this.#maxParameters, 1)) {
      const rows = await transaction
        .select({
          id: authorizationGrants.id,
          revision: authorizationGrants.revision,
        })
        .from(authorizationGrants)
        .where(
          and(
            eq(authorizationGrants.scope, this.#scope),
            inArray(authorizationGrants.id, batch)
          )
        );
      for (const row of rows) {
        actualById.set(row.id, row.revision);
      }
    }
    for (const [id, expectedRevision] of entries) {
      const actual = actualById.get(id);
      if (actual === undefined || actual !== expectedRevision) {
        throw new AuthorizationRevisionError(
          id as GrantId,
          expectedRevision,
          actual ?? null
        );
      }
    }
  }

  async #createClaims(
    transaction: AuthorizationTransaction,
    records: readonly Omit<ClaimRow, "scope">[]
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const record of records) {
      if (seen.has(record.invocationId)) {
        throw new AuthorizationStateError(
          `Invocation ${record.invocationId} has already been claimed`
        );
      }
      seen.add(record.invocationId);
      ids.push(record.invocationId);
    }
    for (const batch of rowBatches(ids, 1, this.#maxParameters, 1)) {
      const existing = await transaction
        .select({ invocationId: authorizationClaims.invocationId })
        .from(authorizationClaims)
        .where(
          and(
            eq(authorizationClaims.scope, this.#scope),
            inArray(authorizationClaims.invocationId, batch)
          )
        );
      if (existing[0] !== undefined) {
        throw new AuthorizationStateError(
          `Invocation ${existing[0].invocationId} has already been claimed`
        );
      }
    }
    const columns = Object.keys(getTableColumns(authorizationClaims)).length;
    const rows = records.map((record) => ({
      ...record,
      scope: this.#scope,
    }));
    for (const batch of rowBatches(rows, columns, this.#maxParameters)) {
      await transaction.insert(authorizationClaims).values(batch);
    }
  }

  async #deleteClaims(
    transaction: AuthorizationTransaction,
    keys: readonly string[]
  ): Promise<void> {
    for (const batch of rowBatches(
      keys.filter(storableText),
      1,
      this.#maxParameters,
      1
    )) {
      await transaction
        .delete(authorizationClaims)
        .where(
          and(
            eq(authorizationClaims.scope, this.#scope),
            inArray(authorizationClaims.invocationId, batch)
          )
        );
    }
  }

  async #deleteGrants(
    transaction: AuthorizationTransaction,
    keys: readonly GrantId[]
  ): Promise<void> {
    for (const batch of rowBatches(
      keys.filter(storableText),
      1,
      this.#maxParameters,
      1
    )) {
      await transaction
        .delete(authorizationGrants)
        .where(
          and(
            eq(authorizationGrants.scope, this.#scope),
            inArray(authorizationGrants.id, batch)
          )
        );
    }
  }

  async #deleteRestrictions(
    transaction: AuthorizationTransaction,
    keys: readonly RestrictionId[]
  ): Promise<void> {
    for (const batch of rowBatches(
      keys.filter(storableText),
      1,
      this.#maxParameters,
      1
    )) {
      await transaction
        .delete(authorizationRestrictions)
        .where(
          and(
            eq(authorizationRestrictions.scope, this.#scope),
            inArray(authorizationRestrictions.id, batch)
          )
        );
    }
  }

  async #putPositioned<
    Table extends typeof authorizationGrants | typeof authorizationRestrictions,
  >(
    transaction: AuthorizationTransaction,
    table: Table,
    records: readonly Omit<Table["$inferInsert"], "position" | "scope">[],
    set: Record<string, SQL>
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const columns = Object.keys(getTableColumns(table)).length;
    const [last] = await transaction
      .select({ position: max(table.position) })
      .from(table)
      .where(eq(table.scope, this.#scope));
    const first = (last?.position ?? 0) + 1;
    const rows = records.map((record, index) => ({
      ...record,
      position: first + index,
      scope: this.#scope,
    })) as Table["$inferInsert"][];
    for (const batch of rowBatches(rows, columns, this.#maxParameters)) {
      await transaction
        .insert(table)
        .values(batch)
        .onConflictDoUpdate({
          set,
          target: [table.scope, table.id],
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
    for (const batch of rowBatches(rows, columns, this.#maxParameters)) {
      await transaction
        .insert(authorizationClaims)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceClaim,
          target: [authorizationClaims.scope, authorizationClaims.invocationId],
        });
    }
  }
}

interface PreparedRows {
  readonly claims: readonly Omit<ClaimRow, "scope">[];
  readonly createClaims: readonly Omit<ClaimRow, "scope">[];
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
    createClaims: (write.createClaims ?? []).map((claim, index) =>
      prepareClaimRow(claim, `createClaims[${index}]`)
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
    requestFingerprint:
      claim.requestFingerprint === undefined
        ? null
        : requireText(claim.requestFingerprint, `${at}.requestFingerprint`),
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
