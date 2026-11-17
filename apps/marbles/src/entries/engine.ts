import { withWorkspaceDatabase } from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";
import { inTurn } from "~/lib/in-turn";

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
