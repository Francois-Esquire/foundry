import type { JsonValue } from "@foundry/lib/json";
import {
  type ProcessIdentity,
  thisProcess,
} from "@foundry/lib/process-identity";
import type {
  Job,
  QueueEvent,
  Run,
  RunState,
  Suspension,
} from "@foundry/queue";
import type { QueueStoreService, QueueWrite } from "@foundry/queue/store";
import { Effect } from "effect";
import type { RunStatus } from "~/lib/workflow-runs";
import { isRunId, runStoreEffect } from "~/lib/workflow-runs";

export interface PutRunOptions {
  readonly at?: number;
  readonly output?: JsonValue;
  readonly owner?: ProcessIdentity;
  readonly step?: string;
}

type Seeded = Exclude<RunStatus, "queued">;

const ENTERED = {
  cancelled: "run.cancelled",
  complete: "run.completed",
  failed: "run.failed",
  running: "run.started",
  suspended: "run.suspended",
} as const satisfies Record<Seeded, QueueEvent["type"]>;

function stateOf(
  status: Seeded,
  at: number,
  suspension: Suspension,
  output: JsonValue,
  owner: ProcessIdentity
): RunState {
  switch (status) {
    case "running":
      return {
        kind: "running",
        lease: { claimedAt: at, owner },
      };
    case "suspended":
      return {
        kind: "suspended",
        suspendedAt: at,
        suspensionId: suspension.id,
      };
    case "complete":
      return { completedAt: at, kind: "complete", output };
    case "failed":
      return {
        error: { message: "seeded failure", name: "Error" },
        failedAt: at,
        kind: "failed",
        retryable: false,
      };
    default:
      return { cancelledAt: at, kind: "cancelled" };
  }
}

const stamp = (at: number) => ({ at, id: `ev-${crypto.randomUUID()}` });

function submitted(id: Run["id"], step: string, at: number): QueueWrite {
  const job: Job = {
    createdAt: at,
    handler: { name: step },
    id: `jb-${id}`,
    input: null,
    links: {},
    policy: {},
    pool: "marbles",
    state: { kind: "pending" },
  };
  const run: Run = {
    attempt: 1,
    id,
    jobId: job.id,
    pool: job.pool,
    revision: 0,
    state: { availableAt: at, kind: "queued", queuedAt: at },
  };
  return {
    events: [
      { ...stamp(at), job, type: "job.submitted" },
      { ...stamp(at), run, type: "run.queued" },
    ],
    jobs: [job],
    runs: [run],
  };
}

function moved(
  run: Run,
  status: Seeded,
  at: number,
  output: JsonValue,
  owner: ProcessIdentity
): QueueWrite {
  const suspension: Suspension = {
    id: `su-${run.id}`,
    key: "seeded",
    kind: "external",
    reason: "seeded",
    request: null,
    revision: 0,
    runId: run.id,
    state: { createdAt: at, kind: "pending" },
  };
  const next: Run = {
    ...run,
    revision: run.revision + 1,
    startedAt: run.startedAt ?? at,
    state: stateOf(status, at, suspension, output, owner),
  };
  return {
    events: [{ ...stamp(at), run: next, type: ENTERED[status] }],
    runs: [next],
    ...(status === "suspended" ? { suspensions: [suspension] } : {}),
  };
}

function stepsTo(status: Seeded | undefined): readonly Seeded[] {
  if (status === undefined) {
    return [];
  }
  return status === "complete" ? ["running", "complete"] : [status];
}

export function putRun(
  store: QueueStoreService,
  id: string,
  status?: Seeded,
  {
    at = Date.now(),
    output = null,
    owner = thisProcess(),
    step = "flow",
  }: PutRunOptions = {}
): Promise<void> {
  if (!isRunId(id)) {
    throw new TypeError(`${id} is not a run id`);
  }
  return runStoreEffect(
    Effect.gen(function* () {
      if ((yield* store.getRun(id)) === undefined) {
        yield* store.commit(submitted(id, step, at));
      }
      const steps = stepsTo(status);
      for (const next of steps) {
        const run = yield* store.getRun(id);
        if (
          run !== undefined &&
          !(next === "running" && run.state.kind === "running")
        ) {
          yield* store.commit(moved(run, next, at, output, owner));
        }
      }
    })
  );
}
