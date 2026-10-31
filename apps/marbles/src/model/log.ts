/** One line of a run's telemetry log, as snapshots record it and the log view shows it. */
export interface LogEntry {
  readonly id: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly stepId?: string;
  readonly timestamp: string;
}

/** A workflow setup's log line: its run, and no step, since setup runs before any. */
export interface SetupLogEntry extends LogEntry {
  readonly runId: string;
  readonly workflow: string;
}
