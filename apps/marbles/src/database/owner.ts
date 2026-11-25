import {
  isGone,
  ownerOf,
  type ProcessIdentity,
  thisProcess,
} from "@foundry/lib/node/process-identity";

export function ownedHere(ownerId: string): {
  readonly ownerId: string;
  readonly ownerPid: number;
  readonly ownerStarted: string | null;
} {
  const { pid, started } = thisProcess();
  return { ownerId, ownerPid: pid, ownerStarted: started };
}

export const NO_OWNER = {
  ownerId: null,
  ownerPid: null,
  ownerStarted: null,
} as const;

function rowOwner(row: {
  readonly ownerPid: number | null;
  readonly ownerStarted: string | null;
}): ProcessIdentity | null {
  return ownerOf(row.ownerPid, row.ownerStarted);
}

export function heldBy(row: {
  readonly ownerPid: number | null;
  readonly ownerStarted: string | null;
}): ProcessIdentity | null {
  const owner = rowOwner(row);
  return owner === null || isGone(owner) ? null : owner;
}

export const CHANGED: unique symbol = Symbol("the owner changed");
const CLAIM_ATTEMPTS = 3;

export interface OwnerColumns {
  readonly ownerId: string | null;
  readonly ownerPid: number | null;
  readonly ownerStarted: string | null;
}

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
