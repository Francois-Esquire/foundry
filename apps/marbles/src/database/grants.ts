import type { GrantDocumentStorage } from "@foundry/lib/config/authorization/document";
import { eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { marblesAgentGrants } from "~/database/tables";

export interface DatabaseGrantStorageOptions {
  /** The database the host keeps open. */
  readonly database: StoreDatabase;
  /** The workspace id. */
  readonly scope: string;
}

/**
 * A workspace's agent grants in the Marbles database: their one document,
 * a row of `marbles_agent_grants` by the workspace id, for
 * `StoredAgentGrantRepository`. Each transaction of the repository is one
 * of the database, so two engines, in this process or another, never both
 * spend a one-shot grant. A lock waited on too long rejects as a
 * `DatabaseBusyError`.
 */
export class DatabaseGrantStorage implements GrantDocumentStorage {
  readonly #database: StoreDatabase;
  readonly #scope: string;

  constructor(options: DatabaseGrantStorageOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
  }

  transact<T>(
    apply: (stored: string | undefined) => {
      readonly next?: string;
      readonly result: T;
    }
  ): Promise<T> {
    return asBusy(() =>
      this.#database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ grants: marblesAgentGrants.grants })
          .from(marblesAgentGrants)
          .where(eq(marblesAgentGrants.scope, this.#scope));
        const { next, result } = apply(row?.grants);
        if (next !== undefined) {
          await transaction
            .insert(marblesAgentGrants)
            .values({ grants: next, scope: this.#scope })
            .onConflictDoUpdate({
              set: { grants: next },
              target: marblesAgentGrants.scope,
            });
        }
        return result;
      })
    );
  }
}
