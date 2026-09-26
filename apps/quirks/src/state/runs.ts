import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunRecord } from "@foundry/workflows/store";
import { InMemoryOrchestratorStore } from "@foundry/workflows/store";

import { isRecord, writeJson } from "~/state/json";
import type { Lock } from "~/state/locks";
import { acquireLock, alive } from "~/state/locks";

/**
 * One file per Run under `<workspace>/runs/`, so two ticks that overlap never
 * write the same file. Each holds everything the store needs to hydrate that
 * Run standalone — including its queue row, because a snapshot without the
 * queue a Run references does not validate — plus what the run scope
 * recorded: the ledger of things the run's steps opened, and the run's
 * session. Those let a parked run replay in a later process and find the
 * same sessions and artifacts. A process that adopts a parked run holds
 * `locks/run-<id>` for as long as it owns the run, so two processes never
 * both resume it.
 */

type Snapshot = ReturnType<InMemoryOrchestratorStore["snapshot"]>;

/** The run scope's state, as it goes into the file. */
export interface RunExtras {
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly session: { readonly id: string };
}

const TERMINAL = new Set(["complete", "failed", "cancelled"]);
const EMPTY: Snapshot = {
  frames: [],
  jobs: [],
  queues: [],
  runs: [],
  suspensions: [],
  version: 1,
};

export function saveRun(
  dir: string,
  snapshot: Snapshot,
  runId: string,
  extras?: RunExtras
): void {
  const run = snapshot.runs.find((record) => record.id === runId);
  if (!run) {
    throw new Error(`run ${runId} is not in the store`);
  }
  const jobId = run.links?.jobId;
  writeJson(join(dir, "runs", `${runId}.json`), {
    frames: snapshot.frames.filter((frame) => frame.runId === runId),
    jobs: snapshot.jobs.filter((job) => job.id === jobId),
    pid: process.pid,
    queue: snapshot.queues.find((queue) => queue.id === run.queueId),
    ...(extras === undefined ? {} : { quirks: extras }),
    run,
    suspensions: snapshot.suspensions.filter((s) => s.runId === runId),
    version: 2,
  });
}

export interface LoadOptions {
  /**
   * Whether a parked run may be taken over here: its definition is
   * registered and this process can answer what it is waiting for. Without
   * this, only settled runs load.
   */
  readonly recover?: (run: RunRecord) => boolean;
}

export interface LoadedRuns {
  /** The ownership lock of each adopted run; released when the run settles or the process stops. */
  readonly locks: ReadonlyMap<string, Lock>;
  /** Parked runs this process adopted, with what their scopes recorded. */
  readonly recovered: ReadonlyMap<string, RunExtras>;
  readonly snapshot: Snapshot;
}

/**
 * Every readable Run as one store snapshot. Each file is validated alone so
 * one bad file costs one Run, not the start. A settled Run always loads. A
 * suspended Run loads when `recover` accepts it, the process that wrote it
 * is gone, and its lock is free; the Orchestrator then parks it again, ready
 * for its answer. Queued and running Runs never load: nothing can pick them
 * up mid-flight.
 */
export function loadRuns(
  dir: string,
  warn: (line: string) => void,
  options: LoadOptions = {}
): LoadedRuns {
  const runs = join(dir, "runs");
  const parts: Snapshot[] = [];
  const recovered = new Map<string, RunExtras>();
  const locks = new Map<string, Lock>();
  if (existsSync(runs)) {
    for (const entry of readdirSync(runs).sort()) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const read = readRun(dir, join(runs, entry), options.recover);
        parts.push(read.snapshot);
        if (read.recovered) {
          recovered.set(read.recovered.id, read.recovered.extras);
          locks.set(read.recovered.id, read.recovered.lock);
        }
      } catch (error) {
        warn(`[state] skipped runs/${entry}: ${message(error)}`);
      }
    }
  }
  const queues = new Map(
    parts.flatMap((part) => part.queues).map((queue) => [queue.id, queue])
  );
  const assembled: Snapshot = {
    frames: parts.flatMap((part) => part.frames),
    jobs: parts.flatMap((part) => part.jobs),
    queues: [...queues.values()],
    runs: parts.flatMap((part) => part.runs),
    suspensions: parts.flatMap((part) => part.suspensions),
    version: 1,
  };
  try {
    return {
      locks,
      recovered,
      snapshot: new InMemoryOrchestratorStore({
        snapshot: assembled,
      }).snapshot(),
    };
  } catch (error) {
    warn(
      `[state] runs/ disagree with each other, starting empty: ${message(error)}`
    );
    for (const lock of locks.values()) {
      lock.release();
    }
    return { locks: new Map(), recovered: new Map(), snapshot: EMPTY };
  }
}

function extrasOf(file: Record<string, unknown>): RunExtras {
  const quirks = isRecord(file.quirks) ? file.quirks : {};
  const session = isRecord(quirks.session) ? quirks.session : {};
  return {
    ledger: isRecord(quirks.ledger) ? quirks.ledger : {},
    session: {
      id: typeof session.id === "string" ? session.id : crypto.randomUUID(),
    },
  };
}

function readRun(
  dir: string,
  path: string,
  recover: LoadOptions["recover"]
): {
  readonly recovered?: {
    readonly extras: RunExtras;
    readonly id: string;
    readonly lock: Lock;
  };
  readonly snapshot: Snapshot;
} {
  const file: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(file)) {
    throw new Error("not a run file");
  }
  const snapshot = new InMemoryOrchestratorStore({
    snapshot: {
      frames: file.frames,
      jobs: file.jobs,
      queues: [file.queue],
      runs: [file.run],
      suspensions: file.suspensions,
      version: 1,
    },
  }).snapshot();
  const [run] = snapshot.runs;
  if (run === undefined) {
    throw new Error("run is missing");
  }
  if (TERMINAL.has(run.status)) {
    return { snapshot };
  }
  if (run.status !== "suspended") {
    throw new Error(`run is ${run.status}, not settled`);
  }
  if (!recover?.(run)) {
    throw new Error("run is suspended; nothing here can resume it");
  }
  const owner = typeof file.pid === "number" ? file.pid : undefined;
  if (owner !== undefined && owner !== process.pid && alive(owner)) {
    throw new Error(`run is suspended in pid ${String(owner)}`);
  }
  // The claim is the lock, not the pid in the file: two processes reading
  // the same dead pid cannot both win it.
  const lock = acquireLock(dir, `run-${run.id}`);
  if (typeof lock === "number") {
    throw new Error(`run is suspended in pid ${String(lock)}`);
  }
  return {
    recovered: { extras: extrasOf(file), id: run.id, lock },
    snapshot,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
