import type { Config } from "@foundry/lib/config";
import { z } from "zod";

import type { Duration, RetryPolicy } from "./types";

export interface StepExecutionDefaults {
  readonly retry?: RetryPolicy;
  readonly timeout?: Duration;
}

export const defaultStepExecution: StepExecutionDefaults = {};

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
  concurrency: z.number().int().positive(),
  defaultName: z.string().min(1),
});

export type QueueConfig = z.infer<typeof QueueConfigSchema>;

export const defaultQueueConfig: QueueConfig = {
  concurrency: 4,
  defaultName: "default",
};

export const QUEUE_CONFIG_PREFIX = "queue";

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
