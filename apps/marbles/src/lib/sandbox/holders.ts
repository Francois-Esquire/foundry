import {
  isProcessIdentity,
  type ProcessIdentity,
  type ProcessState,
} from "@foundry/lib/process-identity";
import type { ContainerRow } from "@foundry/sandbox/store";
import {
  type OwnerLiveness,
  ownerStateOf,
  PORTABLE_OWNER_LIVENESS,
} from "~/lib/recovery/liveness";

export function containerHolder(
  liveness: OwnerLiveness = PORTABLE_OWNER_LIVENESS
): string {
  const { pid, started } = liveness.identity();
  return JSON.stringify({ pid, registry: crypto.randomUUID(), started });
}

function isPortableHolder(holder: unknown): holder is ProcessIdentity {
  return (
    typeof holder === "object" &&
    holder !== null &&
    "pid" in holder &&
    Number.isInteger(holder.pid) &&
    holder.pid === 0 &&
    "started" in holder &&
    (typeof holder.started === "string" || holder.started === null)
  );
}

export function holderState(
  row: ContainerRow,
  liveness: OwnerLiveness = PORTABLE_OWNER_LIVENESS
): ProcessState {
  if (row.holder === undefined) {
    return "unknown";
  }
  let holder: unknown;
  try {
    holder = JSON.parse(row.holder);
  } catch {
    return "unknown";
  }
  if (isProcessIdentity(holder)) {
    return ownerStateOf(liveness, holder);
  }
  if (isPortableHolder(holder) && liveness.identity().pid === 0) {
    return ownerStateOf(liveness, holder);
  }
  return "unknown";
}

export function leftBehind(
  row: ContainerRow,
  liveness: OwnerLiveness = PORTABLE_OWNER_LIVENESS
): boolean {
  return holderState(row, liveness) === "gone";
}
