import {
  isGone,
  ownerOf,
  type ProcessIdentity,
  thisProcess,
} from "@foundry/lib/process-identity";

/**
 * The owner columns Marbles' claim rows keep: the engine (`owner_id`,
 * unique per engine, so two in one process are told apart) and its
 * process, by pid and start time (`owner_pid`, `owner_started`). A row's
 * holder is gone when its process is (`isGone`), so a pid handed to
 * another process since, as after a reboot, holds nothing.
 */

/** The columns that make `ownerId`, in this process, a row's owner. */
export function ownedHere(ownerId: string): {
  readonly ownerId: string;
  readonly ownerPid: number;
  readonly ownerStarted: string | null;
} {
  const { pid, started } = thisProcess();
  return { ownerId, ownerPid: pid, ownerStarted: started };
}

/** The columns of a row no one owns. */
export const NO_OWNER = {
  ownerId: null,
  ownerPid: null,
  ownerStarted: null,
} as const;

/** The process a row's owner columns name; `null` when they name none. */
export function rowOwner(row: {
  readonly ownerPid: number | null;
  readonly ownerStarted: string | null;
}): ProcessIdentity | null {
  return ownerOf(row.ownerPid, row.ownerStarted);
}

/** Whether a row names a holder that is still there. */
export function heldBy(row: {
  readonly ownerPid: number | null;
  readonly ownerStarted: string | null;
}): ProcessIdentity | null {
  const owner = rowOwner(row);
  return owner === null || isGone(owner) ? null : owner;
}
