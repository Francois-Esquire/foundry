import { log } from "@deps/logger";
import { metricsRecord } from "@deps/metrics";
import { sharedRun } from "@deps/shared";
import { toolkitRun } from "@deps/toolkit";

export function alphaTask(): number {
  log("alpha");
  return sharedRun() + sharedRun();
}

export function alphaMetrics(): number {
  return (
    metricsRecord() +
    metricsRecord() +
    metricsRecord() +
    metricsRecord() +
    metricsRecord() +
    metricsRecord() +
    metricsRecord() +
    metricsRecord()
  );
}

export function alphaTools(): number {
  return toolkitRun() + toolkitRun() + toolkitRun();
}
