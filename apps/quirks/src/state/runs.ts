import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { InMemoryOrchestratorStore } from "@foundry/workflows/store";

import { isRecord, writeJson } from "~/state/json";

/**
 * One file per Run under `<workspace>/runs/`, so two ticks that overlap never
 * write the same file. Each holds everything the store needs to hydrate that
 * Run standalone — including its queue row, because a snapshot without the
 * queue a Run references does not validate.
 */

type Snapshot = ReturnType<InMemoryOrchestratorStore["snapshot"]>;

const TERMINAL = new Set(["complete", "failed", "cancelled"]);
const EMPTY: Snapshot = {
  frames: [],
  jobs: [],
  queues: [],
  runs: [],
  suspensions: [],
  version: 1,
};

export function saveRun(dir: string, snapshot: Snapshot, runId: string): void {
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
    run,
    suspensions: snapshot.suspensions.filter((s) => s.runId === runId),
    version: 1,
  });
}

/**
 * Every readable, terminal Run as one store snapshot. Each file is validated
 * alone so one bad file costs one Run, not the start; a non-terminal Run is
 * skipped too, since the Orchestrator would try to resume it.
 */
export function loadRuns(dir: string, warn: (line: string) => void): Snapshot {
  const runs = join(dir, "runs");
  const parts: Snapshot[] = [];
  if (existsSync(runs)) {
    for (const entry of readdirSync(runs).sort()) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        parts.push(readRun(join(runs, entry)));
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
    return new InMemoryOrchestratorStore({ snapshot: assembled }).snapshot();
  } catch (error) {
    warn(
      `[state] runs/ disagree with each other, starting empty: ${message(error)}`
    );
    return EMPTY;
  }
}

function readRun(path: string): Snapshot {
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
  const status = snapshot.runs[0]?.status;
  if (status === undefined || !TERMINAL.has(status)) {
    throw new Error(`run is ${status ?? "missing"}, not settled`);
  }
  return snapshot;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
