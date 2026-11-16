import { withWorkspaceDatabase } from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";

export class Engine extends LibEngine {
  constructor(options: EngineOptions) {
    const { state } = LibEngine.persistence(options);
    super(
      state === undefined
        ? options
        : withWorkspaceDatabase({ ...options, state })
    );
  }
}

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export * from "~/lib/embedded";
