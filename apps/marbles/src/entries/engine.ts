import { defaultWorkspaceRecords } from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";

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
