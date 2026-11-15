/**
 * The embedded-host entry, `@foundry.sh/marbles/engine`: everything
 * `lib/embedded.ts` exports, with the `Engine` this package publishes in
 * place of the `lib/` class. `lib/` may not import the database, so the
 * published class is composed here, a tier above both.
 */

import { defaultWorkspaceRecords } from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";

/**
 * The engine, keeping the workspace's tasks durably whenever it is given a
 * `state`: with no `records`, in the Marbles database (see
 * `defaultWorkspaceRecords` for which), opened at the first task call
 * under the state root's lock rule and closed on `dispose`. `records`
 * chooses otherwise, `new MemoryWorkspaceRecords()` for memory on purpose.
 * Without `state`, the tasks are in memory, as before.
 */
export class Engine extends LibEngine {
  constructor(options: EngineOptions) {
    super(
      options.records !== undefined || options.state === undefined
        ? options
        : {
            ...options,
            records: defaultWorkspaceRecords(
              options.state,
              options.root,
              options.workspaceId
            ),
          }
    );
  }
}

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export * from "~/lib/embedded";
