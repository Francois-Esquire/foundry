import { ownedWrite } from "@foundry/lib/plain-json";
import {
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
import { and, eq, getTableColumns, inArray, max } from "drizzle-orm";
import type { ContainerStore, ContainerStoreWrite } from "./index";
import type { ContainerRow } from "./schema";
import { sandboxContainers } from "./tables";

export type ContainerDatabase = SqliteDatabase;

export type ContainerTransaction = SqliteTransaction;

export interface SqliteContainerStoreOptions {
  readonly database: ContainerDatabase;
  readonly location?: string;
  readonly onCommit?: (
    transaction: ContainerTransaction,
    write: ContainerStoreWrite
  ) => Promise<void>;
  readonly scope: string;
}

const {
  position: _position,
  scope: _scope,
  ...rowColumns
} = getTableColumns(sandboxContainers);

const replaceRow = replacing(rowColumns);

const REENTRY =
  "The SQLite container store was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

const CANNOT_STORE = "The SQLite container store cannot store";

type StoredRow = typeof sandboxContainers.$inferInsert;

export class SqliteContainerStore implements ContainerStore {
  readonly #database: ContainerDatabase;
  readonly #inScope: SQL;
  readonly #location: string | undefined;
  readonly #onCommit: SqliteContainerStoreOptions["onCommit"];
  readonly #scope: string;
  readonly #turns = new Turns(REENTRY);
  #known: string | undefined;

  constructor(options: SqliteContainerStoreOptions) {
    const { scope } = options;
    if (scope.length === 0 || !storableText(scope) || scope.includes(UNIT)) {
      throw new RangeError(
        "scope must be a nonempty string with no U+0000, no U+001F and no lone surrogate"
      );
    }
    this.#database = options.database;
    this.#location = options.location;
    this.#onCommit = options.onCommit;
    this.#scope = scope;
    this.#inScope = eq(sandboxContainers.scope, scope);
  }

  commit(write: ContainerStoreWrite): Promise<void> {
    let owned: ContainerStoreWrite;
    try {
      owned = ownedWrite(write);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    return this.#turns.run(() => {
      const field = unstorableField(owned);
      if (field !== undefined) {
        return Promise.reject(new RangeError(`${CANNOT_STORE} ${field}`));
      }
      const deletes = (owned.deleteContainers ?? []).filter(storableText);
      const puts = owned.putContainers ?? [];
      return this.#database.transaction(async (transaction) => {
        await this.#remove(transaction, deletes);
        await this.#put(transaction, puts);
        await this.#onCommit?.(transaction, owned);
      });
    });
  }

  get(id: string): Promise<ContainerRow | undefined> {
    return this.#turns.run(async () => {
      if (!storableText(id)) {
        return;
      }
      const [row] = await this.#database
        .select(rowColumns)
        .from(sandboxContainers)
        .where(and(this.#inScope, eq(sandboxContainers.id, id)));
      return row === undefined ? undefined : containerRow(row);
    });
  }

  identity(): Promise<string> {
    return this.#turns.run(() => this.#identity());
  }

  list(): Promise<readonly ContainerRow[]> {
    return this.#turns.run(async () => {
      const rows = await this.#database
        .select(rowColumns)
        .from(sandboxContainers)
        .where(this.#inScope)
        .orderBy(sandboxContainers.position);
      return Object.freeze(rows.map(containerRow));
    });
  }

  transaction<T>(work: (view: ContainerStore) => Promise<T>): Promise<T> {
    return this.#turns.run(async () => {
      const identity = await this.#identity();
      return await this.#database.transaction((transaction) => {
        const view = new SqliteContainerStore({
          database: transaction,
          scope: this.#scope,
          ...(this.#onCommit === undefined ? {} : { onCommit: this.#onCommit }),
        });
        view.#known = identity;
        return work(view);
      });
    });
  }

  async #identity(): Promise<string> {
    if (this.#known !== undefined) {
      return this.#known;
    }
    const scope = identityScope(this.#scope);
    await this.#database
      .insert(sandboxContainers)
      .values({
        createdAt: 0,
        holder: null,
        id: IDENTITY_ID,
        nativeId: globalThis.crypto.randomUUID(),
        position: 0,
        scope,
        spec: "{}",
        status: "stopped",
        updatedAt: 0,
      })
      .onConflictDoNothing();
    const [row] = await this.#database
      .select({ nativeId: sandboxContainers.nativeId })
      .from(sandboxContainers)
      .where(
        and(
          eq(sandboxContainers.scope, scope),
          eq(sandboxContainers.id, IDENTITY_ID)
        )
      );
    if (typeof row?.nativeId !== "string" || row.nativeId === "") {
      throw new Error("the container store's identity could not be read");
    }
    this.#known =
      this.#location === undefined
        ? row.nativeId
        : await digest(`${row.nativeId}\u0000${this.#location}`);
    return this.#known;
  }

  async #put(
    transaction: ContainerTransaction,
    rows: readonly ContainerRow[]
  ): Promise<void> {
    const columns = Object.keys(getTableColumns(sandboxContainers)).length;
    const [last] = await transaction
      .select({ position: max(sandboxContainers.position) })
      .from(sandboxContainers)
      .where(this.#inScope);
    const first = (last?.position ?? 0) + 1;
    const stored = rows.map(
      (row, index): StoredRow => ({
        ...row,
        holder: row.holder ?? null,
        nativeId: row.nativeId ?? null,
        position: first + index,
        scope: this.#scope,
      })
    );
    for (const batch of batches(stored, SQLITE_MAX_PARAMETERS / columns)) {
      await transaction
        .insert(sandboxContainers)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceRow,
          target: [sandboxContainers.scope, sandboxContainers.id],
        });
    }
  }

  async #remove(
    transaction: ContainerTransaction,
    ids: readonly string[]
  ): Promise<void> {
    for (const batch of batches(ids, SQLITE_MAX_PARAMETERS - 1)) {
      await transaction
        .delete(sandboxContainers)
        .where(and(this.#inScope, inArray(sandboxContainers.id, batch)));
    }
  }
}

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text)
    )
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const UNIT = "\u001f";

const IDENTITY_ID = "identity";

function identityScope(scope: string): string {
  return `${scope}${UNIT}store`;
}

function containerRow(
  row: Omit<typeof sandboxContainers.$inferSelect, "position" | "scope">
): ContainerRow {
  const { holder, ...rest } = row;
  return Object.freeze({
    ...rest,
    ...(holder === null ? {} : { holder }),
    nativeId: row.nativeId ?? undefined,
  });
}

const TEXT_FIELDS = ["holder", "id", "nativeId", "spec", "status"] as const;

const NUMBER_FIELDS = ["createdAt", "updatedAt"] as const;

function unstorableField(write: ContainerStoreWrite): string | undefined {
  for (const [index, row] of (write.putContainers ?? []).entries()) {
    const path = `putContainers[${index}]`;
    const text = TEXT_FIELDS.find((name) => {
      const value = row[name];
      return typeof value === "string" && !storableText(value);
    });
    if (text !== undefined) {
      return `${path}.${text}: ${UNSTORABLE_TEXT}`;
    }
    const number = NUMBER_FIELDS.find((name) => !storableNumber(row[name]));
    if (number !== undefined) {
      return `${path}.${number}: ${describeNumber(row[number])} does not read back intact from SQLite; a timestamp must be a number within ±Number.MAX_SAFE_INTEGER, and not -0`;
    }
  }
}
