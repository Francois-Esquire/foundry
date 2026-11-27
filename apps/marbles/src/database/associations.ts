import { and, eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import { inList } from "~/database/lists";
import { marblesResourceWorkspaces } from "~/database/tables";
import type { StoreTransaction } from "~/database/transaction";
import type { StoreDatabase } from "~/database/types";
import type {
  AssociationStore,
  AssociationStoreWrite,
  ResourceAssociation,
  ResourceKind,
  ResourceRef,
} from "~/lib/resources";

export interface DatabaseAssociationStoreOptions {
  readonly database: StoreDatabase;
  readonly onCommit?: (
    transaction: StoreTransaction,
    write: AssociationStoreWrite
  ) => Promise<void>;
}

export class DatabaseAssociationStore implements AssociationStore {
  readonly #database: StoreDatabase;
  readonly #onCommit: DatabaseAssociationStoreOptions["onCommit"];

  constructor(options: DatabaseAssociationStoreOptions) {
    this.#database = options.database;
    this.#onCommit = options.onCommit;
  }

  commit(write: AssociationStoreWrite): Promise<void> {
    const removals = [...(write.remove ?? [])];
    const additions = [...(write.put ?? [])];
    const taken: AssociationStoreWrite = {
      events: [...(write.events ?? [])],
      put: additions,
      remove: removals,
    };
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
        await this.#onCommit?.(tx, taken);
      })
    );
  }

  sharedWith(
    kind: ResourceKind,
    workspace: string
  ): Promise<readonly ResourceRef[]> {
    return asBusy(async () => {
      const rows = await this.#database
        .select({
          owner: marblesResourceWorkspaces.owner,
          resourceId: marblesResourceWorkspaces.resourceId,
        })
        .from(marblesResourceWorkspaces)
        .where(
          and(
            eq(marblesResourceWorkspaces.kind, kind),
            eq(marblesResourceWorkspaces.workspace, workspace)
          )
        );
      return rows.map((row) => ({
        id: row.resourceId,
        kind,
        owner: row.owner,
      }));
    });
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

export async function removeShares(
  transaction: Pick<StoreDatabase, "delete">,
  kind: ResourceKind,
  owner: string,
  ids: readonly unknown[]
): Promise<void> {
  const named = ids.filter((id): id is string => typeof id === "string");
  if (named.length === 0) {
    return;
  }
  await transaction
    .delete(marblesResourceWorkspaces)
    .where(
      and(
        eq(marblesResourceWorkspaces.owner, owner),
        eq(marblesResourceWorkspaces.kind, kind),
        inList(marblesResourceWorkspaces.resourceId, named)
      )
    );
}
