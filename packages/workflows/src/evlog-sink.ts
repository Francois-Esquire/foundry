import { createLogger } from "evlog";

import type { AuditOutcome, LogSink, TelemetryLogEntry } from "./telemetry";

export function createEvlogSink(runMeta: {
  readonly runId: string;
  readonly name?: string;
}): LogSink {
  const log = createLogger({
    runId: runMeta.runId,
    ...(runMeta.name === undefined ? {} : { workflow: runMeta.name }),
  });

  const counts: Record<string, number> = {
    debug: 0,
    error: 0,
    info: 0,
    warn: 0,
  };

  return {
    record(entry: TelemetryLogEntry): void {
      counts[entry.level] = (counts[entry.level] ?? 0) + 1;
      log.set({
        logs: [
          {
            at: entry.at,
            level: entry.level,
            message: entry.message,
            ...(entry.stepId === undefined ? {} : { step: entry.stepId }),
            ...(entry.path === undefined ? {} : { path: entry.path }),
            ...(entry.metadata === undefined ? {} : { fields: entry.metadata }),
          },
        ],
      });
    },
    settle(outcome: AuditOutcome): void {
      log.set({
        completedAt: outcome.at,
        logCounts: counts,
        runStatus: outcome.status,
        ...(outcome.metadata ?? {}),
      });
      log.emit();
    },
  };
}
