import { createLogger } from "evlog";

import type { AuditOutcome, LogSink, TelemetryLogEntry } from "./telemetry";

/**
 * First implementation of the swappable {@link LogSink}: one evlog wide-event
 * per run. Granular `ctx.log` lines accumulate as context across the run; a
 * single consolidated audit event is emitted when the run settles.
 *
 * Per evlog's shared-package guidance this only ever calls `createLogger` —
 * never `initLogger`. The host application owns global configuration and the
 * drain that decides where the emitted event lands (console, Axiom, a
 * runs/audit table, …). Wire it in with `workflow.setAuditSink(...)`.
 */
export function createEvlogSink(runMeta: {
  readonly runId: string;
  readonly name?: string;
}): LogSink {
  const log = createLogger({
    runId: runMeta.runId,
    ...(runMeta.name === undefined ? {} : { workflow: runMeta.name }),
  });

  // Counts replace (not concatenate) on `set`, so tally locally and stamp once.
  const counts: Record<string, number> = {
    debug: 0,
    error: 0,
    info: 0,
    warn: 0,
  };

  return {
    record(entry: TelemetryLogEntry): void {
      counts[entry.level] = (counts[entry.level] ?? 0) + 1;
      // evlog merges array fields by concatenation, so each line appends.
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
