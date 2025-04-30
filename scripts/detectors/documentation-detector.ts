import type { BaseStep, Logger } from "./types";

export async function detectDocumentation(
  rootDir: string,
  logger: Logger,
): Promise<BaseStep> {
  // Check for README.md, CONTRIBUTING.md, etc.
  // Optionally extract first heading/description from README.md
  logger.warn("Documentation/Readme detector is not yet implemented.");
  return {
    name: "detectDocumentation",
    durationMs: 0,
    result: {
      warnings: ["Documentation/Readme detector is not yet implemented."],
    },
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
  };
}
