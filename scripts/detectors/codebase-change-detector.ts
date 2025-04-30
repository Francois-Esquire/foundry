import type { BaseStep, Logger } from "./types";

export async function detectCodebaseChange(
  rootDir: string,
  logger: Logger,
): Promise<BaseStep> {
  // Compute hashes for directories/files for robust change tracking
  // Plan for efficient change detection without reading all file contents if possible
  logger.warn("Codebase Change detector is not yet implemented.");
  return {
    name: "detectCodebaseChange",
    durationMs: 0,
    result: { warnings: ["Codebase Change detector is not yet implemented."] },
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
  };
}
