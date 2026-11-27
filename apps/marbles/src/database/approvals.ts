import { eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import { marblesDeferredApprovals } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import type {
  DeferredApprovalStore,
  SavedApprovals,
} from "~/lib/sandbox/deferred-approvals";
import {
  deferredApprovalsSchema,
  emptyApprovals,
} from "~/lib/sandbox/deferred-approvals";

export interface DatabaseDeferredApprovalStoreOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

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
