import { metricsRecord } from "@deps/metrics";
import { SHARED_LIMIT } from "@deps/shared";
import { toolkitRun } from "@deps/toolkit";

export const gammaCap = SHARED_LIMIT + 1;
export const gammaMetric = metricsRecord();
export const gammaTool = toolkitRun();
