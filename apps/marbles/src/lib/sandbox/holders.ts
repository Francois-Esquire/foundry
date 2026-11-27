import {
  isProcessIdentity,
  type ProcessIdentity,
  type ProcessState,
} from "@foundry/lib/process-identity";
import type { ContainerRow } from "@foundry/sandbox/store";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
import { type OwnerLiveness, ownerStateOf } from "~/lib/owner-liveness";

export function containerHolder(
  liveness: OwnerLiveness = NODE_OWNER_LIVENESS
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
  liveness?: OwnerLiveness
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
    return ownerStateOf(liveness ?? NODE_OWNER_LIVENESS, holder);
  }
  if (
    liveness !== undefined &&
    liveness !== NODE_OWNER_LIVENESS &&
    isPortableHolder(holder)
  ) {
    return ownerStateOf(liveness, holder);
  }
  return "unknown";
}

export function leftBehind(
  row: ContainerRow,
  liveness?: OwnerLiveness
): boolean {
  return holderState(row, liveness) === "gone";
}
