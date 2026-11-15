import { eq, max } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { busyError } from "~/database/client";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import {
  marblesIdentityKeys,
  marblesProviderConfigurations,
} from "~/database/tables";
import { writeAsHost } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type {
  ProviderConfigurations,
  ProviderStore,
  ProviderWrites,
} from "~/lib/providers/store";
import {
  ConfigurationError,
  identityKeyFrom,
  keptConfigurations,
  newIdentityKey,
  writtenTexts,
} from "~/lib/providers/store";

/**
 * Provider configuration in the Marbles database, for the whole machine:
 * a row of `marbles_provider_configurations` per scope (the machine's,
 * and each workspace's that keeps one), and the identity key, the one
 * row of `marbles_identity_keys`. An edit reads every scope and writes in
 * one transaction, so it lands over exactly what it read, and every write
 * raises the scope's `revision` above every other, which is what a
 * watcher polls.
 *
 * Its settings may hold secrets, so nothing this store throws quotes
 * them: a failure of the database is reported by its SQLite code alone,
 * a lock waited on too long as `CONFIGURATION_BUSY`.
 */

export interface DatabaseProviderStoreOptions {
  /** The database the host keeps open. */
  readonly database: StoreDatabase;
}

/** The identity key's row: there is one. */
const KEY_ROW = 1;

export class DatabaseProviderStore implements ProviderStore {
  readonly #database: StoreDatabase;

  constructor(options: DatabaseProviderStoreOptions) {
    this.#database = options.database;
  }

  identityKey(make: boolean): Promise<Buffer | undefined> {
    return guarded(async () => {
      if (make) {
        await this.#database
          .insert(marblesIdentityKeys)
          .values({ id: KEY_ROW, key: newIdentityKey() })
          .onConflictDoNothing();
      }
      const [row] = await this.#database
        .select({ key: marblesIdentityKeys.key })
        .from(marblesIdentityKeys)
        .where(eq(marblesIdentityKeys.id, KEY_ROW));
      return row === undefined ? undefined : identityKeyFrom(row.key);
    });
  }

  read(): Promise<ProviderConfigurations> {
    return guarded(() => readAll(this.#database));
  }

  revision(): Promise<number> {
    return guarded(() => highest(this.#database));
  }

  update(
    workspace: string | undefined,
    edit: (current: ProviderConfigurations) => ProviderWrites
  ): Promise<ProviderConfigurations> {
    return guarded(() =>
      this.#database.transaction(async (transaction) => {
        const written = writtenTexts(
          workspace,
          edit(await readAll(transaction))
        );
        if (written.size > 0) {
          const revision = (await highest(transaction)) + 1;
          for (const [scope, configuration] of written) {
            await transaction
              .insert(marblesProviderConfigurations)
              .values({ configuration, revision, scope })
              .onConflictDoUpdate({
                set: { configuration, revision },
                target: marblesProviderConfigurations.scope,
              });
          }
        }
        return readAll(transaction);
      })
    );
  }
}

/**
 * Provider configuration in the Marbles database at the state root
 * `state`, for a process that keeps no handle open: each read through a
 * read-only connection (nothing configured while there is no database),
 * each write as a host writes (`writeAsHost`).
 */
export function stateProviders(state: string): ProviderStore {
  const file = stateDatabase(state);
  const reading = async <T>(
    work: (store: DatabaseProviderStore) => Promise<T>,
    none: T
  ): Promise<T> =>
    (await readDatabase(file, (database) =>
      work(new DatabaseProviderStore({ database }))
    )) ?? none;
  const writing = <T>(
    work: (store: DatabaseProviderStore) => Promise<T>
  ): Promise<T> =>
    writeAsHost(state, (database) =>
      work(new DatabaseProviderStore({ database }))
    );
  return {
    identityKey: (make) =>
      make
        ? writing((store) => store.identityKey(true))
        : reading((store) => store.identityKey(false), undefined),
    read: () => reading((store) => store.read(), keptConfigurations(new Map())),
    revision: () => reading((store) => store.revision(), 0),
    update: (workspace, edit) =>
      writing((store) => store.update(workspace, edit)),
  };
}

async function readAll(
  database: StoreDatabase
): Promise<ProviderConfigurations> {
  const rows = await database
    .select({
      configuration: marblesProviderConfigurations.configuration,
      scope: marblesProviderConfigurations.scope,
    })
    .from(marblesProviderConfigurations);
  return keptConfigurations(
    new Map(rows.map((row) => [row.scope, row.configuration]))
  );
}

async function highest(database: StoreDatabase): Promise<number> {
  const [top] = await database
    .select({ revision: max(marblesProviderConfigurations.revision) })
    .from(marblesProviderConfigurations);
  return top?.revision ?? 0;
}

/**
 * `call`, with a failure of the database reported without what it held:
 * the query and its parameters, which a driver error quotes, may be a
 * secret.
 */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (busyError(error) !== undefined) {
      // biome-ignore lint/style/useErrorCause: the cause quotes the query, whose parameters may be a secret.
      throw new ConfigurationError(
        "CONFIGURATION_BUSY",
        "the provider configuration is being changed by another process; try again"
      );
    }
    if (!(error instanceof DrizzleQueryError)) {
      throw error;
    }
    const { cause } = error;
    // A refusal of Marbles' own, such as a database a newer Marbles
    // migrated, says nothing of what was written: it is passed on alone.
    if (cause instanceof Error && sqliteCode(cause) === undefined) {
      throw cause;
    }
    // biome-ignore lint/style/useErrorCause: the cause quotes the query, whose parameters may be a secret.
    throw new ConfigurationError(
      "CONFIGURATION_UNREADABLE",
      `the provider configuration in the Marbles database cannot be read or written (${sqliteCode(cause) ?? "unknown error"})`
    );
  }
}

/** The SQLite code somewhere along `error`'s causes, if it is the database's failure. */
function sqliteCode(error: unknown): string | undefined {
  for (let at = error; at instanceof Error; at = at.cause) {
    const { code } = at as { readonly code?: unknown };
    if (typeof code === "string" && code.startsWith("SQLITE")) {
      return code;
    }
  }
}
