import { eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { marblesDeferredApprovals } from "~/database/tables";
import type {
  DeferredApprovalStore,
  SavedApprovals,
} from "~/lib/sandbox/deferred-approvals";
import {
  deferredApprovalsSchema,
  emptyApprovals,
} from "~/lib/sandbox/deferred-approvals";

export interface DatabaseDeferredApprovalStoreOptions {
  /** The database the host keeps open. */
  readonly database: StoreDatabase;
  /** The workspace id. */
  readonly scope: string;
}

/**
 * A workspace's deferred approvals in the Marbles database: one row of
 * `marbles_deferred_approvals` by the workspace id, read back through
 * their schema. A change reads and writes in one transaction. A lock
 * waited on too long rejects as a `DatabaseBusyError`.
 */
export class DatabaseDeferredApprovalStore implements DeferredApprovalStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;

  constructor(options: DatabaseDeferredApprovalStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
  }

  change(update: (saved: SavedApprovals) => SavedApprovals): Promise<void> {
    return asBusy(() =>
      this.#database.transaction(async (transaction) => {
        const approvals = deferredApprovalsSchema.parse(
          update(await this.#read(transaction))
        );
        await transaction
          .insert(marblesDeferredApprovals)
          .values({ approvals, scope: this.#scope })
          .onConflictDoUpdate({
            set: { approvals },
            target: marblesDeferredApprovals.scope,
          });
      })
    );
  }

  load(): Promise<SavedApprovals> {
    return asBusy(() => this.#read(this.#database));
  }

  async #read(database: StoreDatabase): Promise<SavedApprovals> {
    const [row] = await database
      .select({ approvals: marblesDeferredApprovals.approvals })
      .from(marblesDeferredApprovals)
      .where(eq(marblesDeferredApprovals.scope, this.#scope));
    return row === undefined
      ? emptyApprovals()
      : deferredApprovalsSchema.parse(row.approvals);
  }
}
