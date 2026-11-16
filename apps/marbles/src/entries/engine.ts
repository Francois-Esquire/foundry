import {
  defaultWorkspaceRecords,
  defaultWorkspaceRuns,
  defaultWorkspaceTriggers,
} from "~/database/managed";
import type { EngineOptions } from "~/lib/engine";
import { Engine as LibEngine } from "~/lib/engine";

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
