import type { SharedMode } from "@deps/shared";

import { metricsRecord } from "@deps/metrics";
import { toolkitRun } from "@deps/toolkit";

export function pick(mode: SharedMode): SharedMode {
  return mode;
}

export const betaMetric = metricsRecord();
export const betaTool = toolkitRun();
