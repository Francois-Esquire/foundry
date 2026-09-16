/**
 * Two config layers: Step execution defaults (retry/timeout) and Queue
 * runtime config (concurrency, queue name) registered on the shared
 * @foundry/lib/config registry.
 */

import type { Config } from "@foundry/lib/config";
import { z } from "zod";

import type { Duration, RetryPolicy } from "./types";

export interface StepExecutionDefaults {
  readonly retry?: RetryPolicy;
  readonly timeout?: Duration;
}

/** Package-wide defaults applied to every Step that doesn't declare its own. */
export const defaultStepExecution: StepExecutionDefaults = {
  // No default retry — opt-in per Step.
  // No default timeout — opt-in per Step.
};

/**
 * Resolve effective execution policy: Step-level fields win, defaults fill
 * gaps. Returned object only contains keys that resolved to a value.
 */
export function resolveStepExecution(step: {
  readonly retry?: RetryPolicy;
  readonly timeout?: Duration;
}): StepExecutionDefaults {
  const merged: { retry?: RetryPolicy; timeout?: Duration } = {};
  const retry = step.retry ?? defaultStepExecution.retry;
  if (retry !== undefined) {
    merged.retry = retry;
  }
  const timeout = step.timeout ?? defaultStepExecution.timeout;
  if (timeout !== undefined) {
    merged.timeout = timeout;
  }
  return merged;
}

export const QueueConfigSchema = z.object({
  /**
   * Maximum number of concurrent runs the orchestrator's queue will
   * execute. Defaults to 4.
   */
  concurrency: z.number().int().positive(),
  /**
   * Name of the default queue row ensured by `Orchestrator.setup()`.
   * Defaults to "default". Override via `contributeQueueConfig` when
   * a composer wants to namespace its persisted queue.
   */
  defaultName: z.string().min(1),
});

export type QueueConfig = z.infer<typeof QueueConfigSchema>;

export const defaultQueueConfig: QueueConfig = {
  concurrency: 4,
  defaultName: "default",
};

export const QUEUE_CONFIG_PREFIX = "queue";

/**
 * Register the queue config slice. `initial` shallow-merges on top of
 * defaults. Idempotent: no-op if already contributed. Called by
 * Orchestrator constructor.
 */
export function contributeQueueConfig(
  config: Config,
  initial?: Partial<QueueConfig>
): void {
  if (config.get(QUEUE_CONFIG_PREFIX) !== undefined) {
    return;
  }
  config.contribute(QUEUE_CONFIG_PREFIX, QueueConfigSchema, {
    ...defaultQueueConfig,
    ...initial,
  });
}

declare module "@foundry/lib/config/types" {
  interface ConfigShape {
    queue?: QueueConfig;
  }
}
