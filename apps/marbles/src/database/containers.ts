import {
  type ProcessIdentity,
  stillRunning,
  thisProcess,
} from "@foundry/lib/spawn-record";
import type {
  ContainerStore,
  ContainerStoreWrite,
} from "@foundry/sandbox/store";
import type { ContainerTransaction } from "@foundry/sandbox/store/sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { marblesContainerOwners } from "~/database/tables";
import type { ContainerOwners } from "~/lib/crash-recovery";

/**
 * Who holds a workspace's container rows, in `marbles_container_owners`:
 * the process that last wrote each, by pid and start time. `ownersOnCommit`
 * is the container store's `onCommit` hook that keeps them, in the
 * commit's own transaction; `DatabaseContainerOwners` reads them to say
 * which rows a process that is gone left. A row without an owner was
 * written before owners were kept, by a process that is gone by now.
 */

/** The hook that files this process as the holder of each row a commit puts. */
export function ownersOnCommit(
  scope: string
): (
  transaction: ContainerTransaction,
  write: ContainerStoreWrite
) => Promise<void> {
  return async (transaction, write) => {
    const deleted = write.deleteContainers ?? [];
    if (deleted.length > 0) {
      await transaction
        .delete(marblesContainerOwners)
        .where(
          and(
            eq(marblesContainerOwners.scope, scope),
            inArray(marblesContainerOwners.containerId, [...deleted])
          )
        );
    }
    const put = write.putContainers ?? [];
    if (put.length === 0) {
      return;
    }
    const owner = thisProcess();
    const held = { ownerPid: owner.pid, ownerStarted: owner.started };
    for (const row of put) {
      await transaction
        .insert(marblesContainerOwners)
        .values({ containerId: row.id, ...held, scope })
        .onConflictDoUpdate({
          set: held,
          target: [
            marblesContainerOwners.scope,
            marblesContainerOwners.containerId,
          ],
        });
    }
  };
}

export interface DatabaseContainerOwnersOptions {
  /** The workspace's container rows, as the package keeps them. */
  readonly containers: Pick<ContainerStore, "list">;
  readonly database: StoreDatabase;
  /** The workspace id. */
  readonly scope: string;
}

/** Which of a workspace's container rows a process that is gone left. */
export class DatabaseContainerOwners implements ContainerOwners {
  readonly #containers: Pick<ContainerStore, "list">;
  readonly #database: StoreDatabase;
  readonly #scope: string;

  constructor(options: DatabaseContainerOwnersOptions) {
    this.#containers = options.containers;
    this.#database = options.database;
    this.#scope = options.scope;
  }

  /**
   * Whether the row `id`'s holder is gone: no process runs with its pid
   * and start time, or none is recorded (a row written before holders
   * were kept).
   */
  async left(id: string): Promise<boolean> {
    const [row] = await asBusy(() =>
      this.#database
        .select({
          id: marblesContainerOwners.containerId,
          pid: marblesContainerOwners.ownerPid,
          started: marblesContainerOwners.ownerStarted,
        })
        .from(marblesContainerOwners)
        .where(
          and(
            eq(marblesContainerOwners.scope, this.#scope),
            eq(marblesContainerOwners.containerId, id)
          )
        )
    );
    return row === undefined || gone({ pid: row.pid, started: row.started });
  }

  /** Whether any row the container store keeps was left by a process that is gone. */
  async anyLeft(): Promise<boolean> {
    for (const { id } of await this.#containers.list()) {
      if (await this.left(id)) {
        return true;
      }
    }
    return false;
  }
}

function gone(owner: ProcessIdentity): boolean {
  const self = thisProcess();
  if (owner.pid === self.pid && owner.started === self.started) {
    return false;
  }
  return !stillRunning(owner);
}
