/**
 * The embedded-host entry, `@foundry.sh/marbles/engine`: everything
 * `lib/embedded.ts` exports, with the `Engine` this package publishes in
 * place of the `lib/` class. `lib/` may not import the database, so the
 * published class is composed here, a tier above both.
 */

import { withWorkspaceDatabase } from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";
import { inTurn } from "~/lib/in-turn";

/**
 * The engine, keeping the workspace's tasks, workflow and Execution Runs,
 * trigger state, automations, usage, agent grants, deferred approvals and
 * activities durably whenever it is given a `state`: each it is not handed
 * in the Marbles database (see `defaultStateRoot` for which), over one
 * handle opened at the first call under the state root's lock rule and
 * closed once `dispose` has settled (`withWorkspaceDatabase`). Each option
 * chooses otherwise: `new MemoryWorkspaceRecords()`, `new MemoryRunStore()`,
 * `new MemoryExecutionStore()`, `new MemoryTriggerStore()`,
 * `new MemoryAutomationStore()` and `new MemoryUsageStore()` for memory on
 * purpose. Without `state`, all are in memory, as before.
 */
export class Engine extends LibEngine {
  readonly #release: () => Promise<void>;
  #disposing: Promise<void> | undefined;

  constructor(options: EngineOptions) {
    const { state } = options;
    const kept =
      state === undefined
        ? undefined
        : withWorkspaceDatabase({ ...options, state });
    super(kept?.options ?? options);
    this.#release = kept?.release ?? (() => Promise.resolve());
  }

  /** {@link LibEngine.dispose}, then the engine's hold on the database is given up, whether or not it rejected. */
  override dispose(): Promise<void> {
    this.#disposing ??= this.#dispose();
    return this.#disposing;
  }

  #dispose(): Promise<void> {
    return inTurn(
      () => super.dispose(),
      () => this.#release(),
      "Failed to dispose the engine and give up its database"
    );
  }
}

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export * from "~/lib/embedded";
