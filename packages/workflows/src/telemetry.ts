export interface TelemetryMetrics {
  readonly updatedAt: string;
  readonly values: Readonly<Record<string, number>>;
}

export interface TelemetryLogEntry {
  readonly at: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Path of the emitting step in the run tree. */
  readonly path?: readonly string[];
  /** Id of the step that emitted this line (omitted for engine-level logs). */
  readonly stepId?: string;
}

/**
 * Terminal audit record for a run — the consolidated "wide event" flushed
 * once when the run settles.
 */
export interface AuditOutcome {
  readonly at: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly status: string;
}

/**
 * The swappable logging/audit backend.
 *
 * The engine emits granular, path-scoped lines through {@link LogSink.record}
 * as steps run, and flushes one consolidated audit event per run through
 * {@link LogSink.settle} when the run terminates. The default is {@link noopSink};
 * a host swaps in a concrete implementation (e.g. the evlog wide-event sink in
 * `evlog-sink.ts`). Keep this surface narrow so backends stay interchangeable.
 */
export interface LogSink {
  record(entry: TelemetryLogEntry): void;
  settle(outcome: AuditOutcome): void;
}

/** No-op sink. Logging stays inert until a host swaps in a real backend. */
export const noopSink: LogSink = {
  /* eslint-disable @typescript-eslint/no-empty-function -- inert by design */
  record() {},
  settle() {},
  /* eslint-enable @typescript-eslint/no-empty-function */
};

/**
 * The callback the engine threads into the step context. A durable function
 * body calls `ctx.log(...)`, which routes here; the engine wires this to the
 * run's telemetry ring + live state and the swappable {@link LogSink}.
 */
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
    this.#logCapacity = options.logCapacity ?? 200; // max log entries retained
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
