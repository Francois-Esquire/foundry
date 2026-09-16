import { randomUUID } from "node:crypto";

import { Config } from "@foundry/lib/config";

import type { QueueConfig } from "../../config";

import { contributeQueueConfig } from "../../config";

export function makeOrchestratorConfig(
  overrides: Partial<QueueConfig> = {}
): Config {
  const config = new Config();
  contributeQueueConfig(config, {
    concurrency: 1,
    defaultName: `test-${randomUUID()}`,
    ...overrides,
  });
  return config;
}
