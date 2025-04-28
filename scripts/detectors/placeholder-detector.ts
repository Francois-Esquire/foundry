import type { BaseStep, Logger } from "./types";

export async function placeholderDetector(
  name: string,
  logger: Logger,
): Promise<BaseStep> {
  logger.warn(`${name} detector is not yet implemented.`);
  return {
    name,
    durationMs: 0,
    result: { warnings: [`${name} detector is not yet implemented.`] },
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
  };
}
