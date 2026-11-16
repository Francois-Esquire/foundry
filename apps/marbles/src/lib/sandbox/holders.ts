import { randomUUID } from "node:crypto";
import {
  isProcessIdentity,
  type ProcessState,
  processState,
  thisProcess,
} from "@foundry/lib/process-identity";
import type { ContainerRow } from "@foundry/sandbox/store";

/**
 * Who holds a container row, as the registries Marbles builds write it
 * (`CreateContainersOptions.holder`): this process, as a
 * `ProcessIdentity`, and the registry, so two in one process are told
 * apart. A start takes back the rows whose holder is gone
 * (`Containers.recover`, through `lib/crash-recovery.ts`).
 */

/** A holder token for a new registry in this process. */
export function containerHolder(): string {
  const { pid, started } = thisProcess();
  return JSON.stringify({ pid, registry: randomUUID(), started });
}

/**
 * What can be said of `row`'s holder, by the one rule for processes
 * (`processState`): `gone` only on proof; `running` when it is there;
 * `unknown` when it cannot be told, which is never taken for gone: a
 * holder that names no process this can read (a row written before
 * holders were kept, or one that is not a holder), or one whose process
 * cannot be told gone or running.
 */
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

/** Whether a process that is gone left `row`: its holder is gone on proof. */
export function leftBehind(row: ContainerRow): boolean {
  return holderState(row) === "gone";
}
