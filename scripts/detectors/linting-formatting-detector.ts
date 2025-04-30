import type { BaseStep, Logger } from "./types";

export async function detectLintingFormatting(
  rootDir: string,
  logger: Logger,
): Promise<BaseStep> {
  // Detect ESLint, Prettier, Stylelint, etc. via dependencies or config files
  // List config files found
  logger.warn("Linting/Formatting detector is not yet implemented.");
  return {
    name: "detectLintingFormatting",
    durationMs: 0,
    result: {
      warnings: ["Linting/Formatting detector is not yet implemented."],
    },
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
  };
}
