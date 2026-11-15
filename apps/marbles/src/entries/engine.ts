/**
 * The embedded-host entry, `@foundry.sh/marbles/engine`: everything
 * `lib/embedded.ts` exports, with the `Engine` this package publishes in
 * place of the `lib/` class. `lib/` may not import the database, so the
 * published class is composed here, a tier above both.
 */

import {
  defaultWorkspaceRecords,
  defaultWorkspaceRuns,
  defaultWorkspaceTriggers,
} from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";

/**
 * The engine, keeping the workspace's tasks, workflow Runs and trigger
 * state durably whenever it is given a `state`: with no `records`, `runs`
 * or `triggers`, in the Marbles database (see `defaultWorkspaceRecords`
 * for which), each opened at its first call under the state root's lock
 * rule and closed on `dispose`. Each option chooses otherwise:
 * `new MemoryWorkspaceRecords()`, `new MemoryRunStore()` and
 * `new MemoryTriggerStore()` for memory on purpose. Without `state`, all
 * are in memory, as before.
 */
export class Engine extends LibEngine {
  constructor(options: EngineOptions) {
    const { root, state, workspaceId } = options;
    super(
      state === undefined
        ? options
        : {
            ...options,
            records:
              options.records ??
              defaultWorkspaceRecords(state, root, workspaceId),
            runs:
              options.runs ?? defaultWorkspaceRuns(state, root, workspaceId),
            triggers:
              options.triggers ??
              defaultWorkspaceTriggers(state, root, workspaceId),
          }
    );
  }
}

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export * from "~/lib/embedded";
