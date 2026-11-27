import type { GrantDocumentStorage } from "@foundry/lib/authorization/document";
import { eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import { marblesAgentGrants } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";

export interface DatabaseGrantStorageOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

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
