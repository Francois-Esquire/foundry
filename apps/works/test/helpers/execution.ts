import { onTestFinished } from "vitest";
import type { WorksEngineOptions } from "~/main/execution/engine";
import { startWorksEngine } from "~/main/execution/engine";

/**
 * The real Works engine, in memory unless given a directory, closed when the
 * test finishes. Node tests only: the engine does not load under happy-dom.
 */
export async function startTestExecution(options: WorksEngineOptions = {}) {
  const execution = await startWorksEngine(options);
  onTestFinished(() => execution.close());
  return execution;
}
