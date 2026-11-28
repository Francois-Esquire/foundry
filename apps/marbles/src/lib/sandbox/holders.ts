import {
  isProcessIdentity,
  type OwnerLiveness,
  ownerStateOf,
  PORTABLE_OWNER_LIVENESS,
  type ProcessState,
} from "@foundry/lib/process-identity";
import type { ContainerRow } from "@foundry/sandbox/store";

export function containerHolder(
  liveness: OwnerLiveness = PORTABLE_OWNER_LIVENESS
): string {
  const { pid, started } = liveness.identity();
  return JSON.stringify({ pid, registry: crypto.randomUUID(), started });
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
  return "unknown";
}

export function leftBehind(
  row: ContainerRow,
  liveness: OwnerLiveness = PORTABLE_OWNER_LIVENESS
): boolean {
  return holderState(row, liveness) === "gone";
}
