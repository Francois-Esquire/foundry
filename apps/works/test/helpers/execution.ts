import { onTestFinished } from "vitest";
import type { WorksEngineOptions } from "~/main/execution/engine";
import { startWorksEngine } from "~/main/execution/engine";

export async function startTestExecution(options: WorksEngineOptions = {}) {
  const execution = await startWorksEngine(options);
  onTestFinished(() => execution.close());
  return execution;
}
