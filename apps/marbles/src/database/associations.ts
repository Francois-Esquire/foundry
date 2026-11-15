import { and, eq, inArray } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { marblesResourceWorkspaces } from "~/database/tables";
import type {
  AssociationStore,
  AssociationStoreWrite,
  ResourceAssociation,
  ResourceKind,
} from "~/lib/resources";

export interface DatabaseAssociationStoreOptions {
  /** The database or one of its transactions; the host opens and closes it. */
  readonly database: StoreDatabase;
}

/**
 * The workspaces resources are shared with, in the Marbles database
 * (`marbles_resource_workspaces`), for every workspace at once: a
 * resource's owner and id are its key, so the table has no scope of its
 * own. A write is one transaction; a lock waited on too long surfaces as a
 * `DatabaseBusyError`.
 */
export class DatabaseAssociationStore implements AssociationStore {
  readonly #database: StoreDatabase;

  constructor(options: DatabaseAssociationStoreOptions) {
    this.#database = options.database;
  }

  commit(write: AssociationStoreWrite): Promise<void> {
    const removals = [...(write.remove ?? [])];
    const additions = [...(write.put ?? [])];
    return asBusy(() =>
      this.#database.transaction(async (tx) => {
        for (const { ref, workspace } of removals) {
          await tx
            .delete(marblesResourceWorkspaces)
            .where(
              and(
                eq(marblesResourceWorkspaces.owner, ref.owner),
                eq(marblesResourceWorkspaces.kind, ref.kind),
                eq(marblesResourceWorkspaces.resourceId, ref.id),
                eq(marblesResourceWorkspaces.workspace, workspace)
              )
            );
        }
        for (const { associatedAt, ref, workspace } of additions) {
          await tx
            .insert(marblesResourceWorkspaces)
            .values({
              associatedAt,
              kind: ref.kind,
              owner: ref.owner,
              resourceId: ref.id,
              workspace,
            })
            .onConflictDoNothing();
        }
      })
    );
  }

  list(kind: ResourceKind): Promise<readonly ResourceAssociation[]> {
    return asBusy(async () => {
      const rows = await this.#database
        .select()
        .from(marblesResourceWorkspaces)
        .where(eq(marblesResourceWorkspaces.kind, kind));
      return rows.map((row) => ({
        associatedAt: row.associatedAt,
        ref: { id: row.resourceId, kind: row.kind, owner: row.owner },
        workspace: row.workspace,
      }));
    });
  }
}

/**
 * Remove the shares of the resources of `kind` with `ids` that the
 * workspace `owner` keeps, in `transaction`: a store's `onCommit` hook
 * calls it as the commit removes them, so a share never outlives its
 * resource, nor shows a later one given the same id.
 */
export async function removeShares(
  transaction: Pick<StoreDatabase, "delete">,
  kind: ResourceKind,
  owner: string,
  ids: readonly string[]
): Promise<void> {
  for (const batch of chunks(ids)) {
    await transaction
      .delete(marblesResourceWorkspaces)
      .where(
        and(
          eq(marblesResourceWorkspaces.owner, owner),
          eq(marblesResourceWorkspaces.kind, kind),
          inArray(marblesResourceWorkspaces.resourceId, batch)
        )
      );
  }
}

/** Ids per statement, well under SQLite's parameter limit. */
const BATCH = 500;

function chunks(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += BATCH) {
    batches.push(ids.slice(start, start + BATCH));
  }
  return batches;
}
