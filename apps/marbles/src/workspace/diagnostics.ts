import type { LogOrigin } from "~/lib/log";
import type { LogEntry, SetupLogEntry } from "~/model/log";

const TROUBLE =
  /\b(error|failed|could not|not saved|not published|unavailable)\b/i;
const DEFAULT_LIMIT = 500;

export function lineLevel(line: string): LogEntry["level"] {
  return TROUBLE.test(line) ? "warn" : "info";
}

export class Diagnostics {
  readonly #limit: number;
  readonly #now: () => Date;
  #entries: readonly LogEntry[] = [];
  #setup: readonly SetupLogEntry[] = [];
  #next = 0;

  constructor(limit = DEFAULT_LIMIT, now: () => Date = () => new Date()) {
    this.#limit = limit;
    this.#now = now;
  }

  add(message: string, level: LogEntry["level"] = lineLevel(message)): void {
    this.#next += 1;
    this.#entries = [
      ...this.#entries,
      {
        id: `host:${this.#next}`,
        level,
        message,
        timestamp: this.#now().toISOString(),
      },
    ].slice(-this.#limit);
  }

  setup(
    level: LogEntry["level"],
    message: string,
    run: { readonly runId: string; readonly workflow: string }
  ): void {
    this.#next += 1;
    this.#setup = [
      ...this.#setup,
      {
        id: `setup:${this.#next}`,
        level,
        message,
        runId: run.runId,
        timestamp: this.#now().toISOString(),
        workflow: run.workflow,
      },
    ].slice(-this.#limit);
  }

  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  get setupEntries(): readonly SetupLogEntry[] {
    return this.#setup;
  }
}

export function hostOutput(
  diagnostics: Diagnostics,
  status: (line: string) => void
): {
  readonly log: (
    level: LogEntry["level"],
    message: string,
    origin: LogOrigin
  ) => void;
  readonly print: (line: string) => void;
} {
  return {
    log: (level, message, origin) => {
      status(message);
      if (origin.kind === "setup") {
        diagnostics.setup(level, message, origin);
      }
    },
    print: (line) => {
      status(line);
      diagnostics.add(line);
    },
  };
}
