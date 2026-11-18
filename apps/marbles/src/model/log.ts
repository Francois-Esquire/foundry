export interface LogEntry {
  readonly id: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly stepId?: string;
  readonly timestamp: string;
}

export interface SetupLogEntry extends LogEntry {
  readonly runId: string;
  readonly workflow: string;
}
