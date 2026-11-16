import { randomUUID } from "node:crypto";
import {
  isGone,
  isProcessIdentity,
  thisProcess,
} from "@foundry/lib/process-identity";
import type { ContainerRow } from "@foundry/sandbox/store";

export function containerHolder(): string {
  const { pid, started } = thisProcess();
  return JSON.stringify({ pid, registry: randomUUID(), started });
}

export function leftBehind(row: ContainerRow): boolean {
  if (row.holder === undefined) {
    return true;
  }
  let holder: unknown;
  try {
    holder = JSON.parse(row.holder);
  } catch {
    return true;
  }
  return !isProcessIdentity(holder) || isGone(holder);
}
