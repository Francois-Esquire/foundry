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

/** What a claim's transaction answers when the owner changed since it looked. */
export const CHANGED: unique symbol = Symbol("the owner changed");
const CLAIM_ATTEMPTS = 3;

/** A claim row's owner columns, as one read found them. */
export interface OwnerColumns {
  readonly ownerId: string | null;
  readonly ownerPid: number | null;
  readonly ownerStarted: string | null;
}

/** Whether two reads of a claim row found the same owner, exactly. */
export function sameOwnerColumns(
  one: OwnerColumns | undefined,
  other: OwnerColumns | undefined
): boolean {
  return (
    (one?.ownerId ?? null) === (other?.ownerId ?? null) &&
    (one?.ownerPid ?? null) === (other?.ownerPid ?? null) &&
    (one?.ownerStarted ?? null) === (other?.ownerStarted ?? null)
  );
}

/**
 * How a claim decides on a row's owner without asking the system while
 * it holds the write lock: `look` reads the owner columns and `judge`
 * decides on them, both outside any transaction; `claim` then runs in
 * its transaction with what was looked at and decided, and answers
 * `CHANGED` when the owner it finds there is not the one judged, so the
 * whole is tried again, up to `CLAIM_ATTEMPTS` times. One whose owner
 * keeps changing answers `refused`.
 */
export async function claimJudged<J, T>(
  look: () => Promise<OwnerColumns | undefined>,
  judge: (seen: OwnerColumns | undefined) => J,
  claim: (
    seen: OwnerColumns | undefined,
    judged: J
  ) => Promise<T | typeof CHANGED>,
  refused: T
): Promise<T> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const seen = await look();
    const result = await claim(seen, judge(seen));
    if (result !== CHANGED) {
      return result;
    }
  }
  return refused;
}
