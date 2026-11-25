import { randomUUID } from "node:crypto";
import {
  isProcessIdentity,
  type ProcessState,
  processState,
  thisProcess,
} from "@foundry/lib/node/process-identity";
import type { ContainerRow } from "@foundry/sandbox/store";

export function containerHolder(): string {
  const { pid, started } = thisProcess();
  return JSON.stringify({ pid, registry: randomUUID(), started });
}

export function holderState(row: ContainerRow): ProcessState {
  if (row.holder === undefined) {
    return "unknown";
  }
  let holder: unknown;
  try {
    holder = JSON.parse(row.holder);
  } catch {
    return "unknown";
  }
  return isProcessIdentity(holder) ? processState(holder) : "unknown";
}

export function leftBehind(row: ContainerRow): boolean {
  return holderState(row) === "gone";
}
