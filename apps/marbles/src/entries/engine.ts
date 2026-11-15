/**
 * The embedded-host entry, `@foundry.sh/marbles/engine`: everything
 * `lib/embedded.ts` exports, with the `Engine` this package publishes in
 * place of the `lib/` class. `lib/` may not import the database, so the
 * published class is composed here, a tier above both.
 */

import {
  defaultWorkspaceRecords,
  defaultWorkspaceRuns,
} from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";

/**
 * The engine, keeping the workspace's tasks and workflow Runs durably
 * whenever it is given a `state`: with no `records`, or no `runs`, in the
 * Marbles database (see `defaultWorkspaceRecords` for which), each opened
 * at its first call under the state root's lock rule and closed on
 * `dispose`. `records` and `runs` choose otherwise:
 * `new MemoryWorkspaceRecords()` and `new MemoryRunStore()` for memory on
 * purpose. Without `state`, both are in memory, as before.
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
          }
    );
  }
}

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export * from "~/lib/embedded";
