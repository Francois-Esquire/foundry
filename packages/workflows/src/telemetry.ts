interface TelemetryMetrics {
  readonly updatedAt: string;
  readonly values: Readonly<Record<string, number>>;
}

export interface TelemetryLogEntry {
  readonly at: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly path?: readonly string[];
  readonly stepId?: string;
}

export interface AuditOutcome {
  readonly at: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly status: string;
}

export interface LogSink {
  record(entry: TelemetryLogEntry): void;
  settle(outcome: AuditOutcome): void;
}

export const noopSink: LogSink = {
  record: () => undefined,
  settle: () => undefined,
};

export type LogCallback = (entry: TelemetryLogEntry) => void;

export interface TelemetryState {
  readonly logs: readonly TelemetryLogEntry[];
  readonly metrics: TelemetryMetrics;
}

export interface TelemetryOptions {
  readonly logCapacity?: number;
}

export class Telemetry {
  readonly #logCapacity: number;
  readonly #metrics = new Map<string, number>();
  #metricsUpdatedAt = new Date().toISOString();
  readonly #logs: TelemetryLogEntry[] = [];

  constructor(options: TelemetryOptions = {}) {
    this.#logCapacity = options.logCapacity ?? 200;
  }

  incrementMetric(key: string, by = 1): void {
    const current = this.#metrics.get(key) ?? 0;
    this.#metrics.set(key, current + by);
    this.#metricsUpdatedAt = new Date().toISOString();
  }

  setMetric(key: string, value: number): void {
    this.#metrics.set(key, value);
    this.#metricsUpdatedAt = new Date().toISOString();
  }

  appendLog(
    entry: Omit<TelemetryLogEntry, "at"> & { readonly at?: string }
  ): void {
    const next: TelemetryLogEntry = {
      at: entry.at ?? new Date().toISOString(),
      level: entry.level,
      message: entry.message,
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      ...(entry.stepId === undefined ? {} : { stepId: entry.stepId }),
      ...(entry.path === undefined ? {} : { path: entry.path }),
    };
    this.#logs.push(next);
    if (this.#logs.length > this.#logCapacity) {
      this.#logs.splice(0, this.#logs.length - this.#logCapacity);
    }
  }

  restore(state: TelemetryState): void {
    this.#metrics.clear();
    for (const [key, value] of Object.entries(state.metrics.values)) {
      this.#metrics.set(key, value);
    }
    this.#metricsUpdatedAt = state.metrics.updatedAt;
    this.#logs.splice(
      0,
      this.#logs.length,
      ...state.logs.slice(-this.#logCapacity)
    );
  }

  snapshot(): TelemetryState {
    return {
      logs: [...this.#logs],
      metrics: {
        updatedAt: this.#metricsUpdatedAt,
        values: Object.fromEntries(this.#metrics.entries()),
      },
    };
  }
}
