import { withWorkspaceDatabase } from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";
import { inTurn } from "~/lib/in-turn";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";

export class Engine extends LibEngine {
  readonly #release: () => Promise<void>;
  #disposing: Promise<void> | undefined;

  constructor(options: EngineOptions) {
    const withHostDefaults: EngineOptions =
      options.liveness === undefined
        ? { ...options, liveness: NODE_OWNER_LIVENESS }
        : options;
    const { state } = LibEngine.persistence(withHostDefaults);
    const kept =
      state === undefined
        ? undefined
        : withWorkspaceDatabase({ ...withHostDefaults, state });
    super(kept?.options ?? withHostDefaults);
    this.#release = kept?.release ?? (() => Promise.resolve());
  }

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
