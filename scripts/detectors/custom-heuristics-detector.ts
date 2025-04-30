import type { BaseStep, Logger } from "./types";

export async function detectCustomHeuristics(
  rootDir: string,
  logger: Logger,
): Promise<BaseStep> {
  // Detect Dockerfiles, deployment configs, infra-as-code
  // Detect usage of specific cloud providers/services
  logger.warn(
    "Custom/Project-Specific Heuristics detector is not yet implemented.",
  );
  return {
    name: "detectCustomHeuristics",
    durationMs: 0,
    result: {
      warnings: [
        "Custom/Project-Specific Heuristics detector is not yet implemented.",
      ],
    },
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
  };
}
