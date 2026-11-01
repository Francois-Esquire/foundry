import type { LogOrigin } from "~/lib/log";
import type { LogEntry, SetupLogEntry } from "~/model/log";

/**
 * A host's own lines (engine status, schedule ticks, warnings, failed
 * launches) kept in memory for the dashboard's Logs tab. Nothing is written
 * or sent: they last as long as the process keeping them, the newest `limit`.
 */

const TROUBLE =
  /\b(error|failed|could not|not saved|not published|unavailable)\b/i;
const DEFAULT_LIMIT = 500;

/** A level for a printed line: trouble words read as a warning, the rest as info. */
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

  /** A workflow setup's line, kept with its run: no run record keeps it. */
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

  /** Oldest first; a new array only when a line was added. */
  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  /** Workflow setups' lines, oldest first. */
  get setupEntries(): readonly SetupLogEntry[] {
    return this.#setup;
  }
}

/**
 * A workspace host's two outputs for its engine. `print` carries the
 * engine's own lines: each becomes the status line and a diagnostic.
 * `log` carries definitions' `log(...)` lines with their origin, and each
 * becomes the status line. A step body's line is in its run's record
 * already, so the Logs tab shows it from there, with its run and step. A
 * workflow setup's line is in no record, so it is kept here with its run.
 */
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
