import { randomUUID } from "node:crypto";
import {
  isGone,
  isProcessIdentity,
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
 * Whether a process that is gone left `row`: its holder names a process
 * that is gone (`isGone`), or names none this can read, as a row written
 * before holders were kept does.
 */
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
