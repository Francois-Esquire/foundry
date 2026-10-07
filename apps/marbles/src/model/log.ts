/** One line of a run's telemetry log, as snapshots record it and the log view shows it. */
export interface LogEntry {
  readonly id: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly stepId?: string;
  readonly timestamp: string;
}
