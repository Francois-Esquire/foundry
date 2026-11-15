/**
 * The embedded-host entry, `@foundry.sh/marbles/engine`: everything
 * `lib/embedded.ts` exports, with the `Engine` this package publishes in
 * place of the `lib/` class. `lib/` may not import the database, so the
 * published class is composed here, a tier above both.
 */

import { withWorkspaceDatabase } from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";

/**
 * The engine, keeping the workspace's tasks, workflow Runs, trigger state
 * and usage durably whenever it is given a `state`: each it is not handed
 * in the Marbles database (see `defaultWorkspaceRecords` for which), over
 * one handle opened at the first call under the state root's lock rule
 * and closed on `dispose` (`withWorkspaceDatabase`). Each option chooses
 * otherwise: `new MemoryWorkspaceRecords()`, `new MemoryRunStore()`,
 * `new MemoryTriggerStore()` and `new MemoryUsageStore()` for memory on
 * purpose. Without `state`, all are in memory, as before.
 */
export class Engine extends LibEngine {
  constructor(options: EngineOptions) {
    const { state } = options;
    super(
      state === undefined
        ? options
        : withWorkspaceDatabase({ ...options, state })
    );
  }
}

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export * from "~/lib/embedded";
