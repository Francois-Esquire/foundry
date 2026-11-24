import type { JsonValue } from "@foundry/lib/json";
import {
  type ProcessIdentity,
  sameProcess,
} from "@foundry/lib/process-identity";
import type {
  ErrorShape,
  Instant,
  Job,
  JobId,
  PoolName,
  QueueEvent,
  Run,
  RunId,
  Suspension,
} from "./domain";
import type { QueueWrite } from "./store/index";

type Fact = QueueEvent extends infer Event
  ? Event extends QueueEvent
    ? Omit<Event, "at" | "id">
    : never
  : never;

export interface Change {
  readonly facts: readonly Fact[];
  readonly write: QueueWrite;
}

export interface FollowUp {
  readonly facts: readonly Fact[];
  readonly jobs: readonly Job[];
  readonly runs: readonly Run[];
}

export interface QueuedRunInput {
  readonly at: Instant;
  readonly attempt: number;
  readonly checkpoint?: JsonValue;
  readonly id: RunId;
  readonly jobId: JobId;
  readonly now: Instant;
  readonly owner: ProcessIdentity;
  readonly pool: PoolName;
}

export const bump = (run: Run, state: Run["state"]): Run => ({
  ...run,
  revision: run.revision + 1,
  state,
});

export const availableAt = (run: Run) =>
  run.state.kind === "queued" ? run.state.availableAt : 0;

export const queuedRun = (input: QueuedRunInput): Run => ({
  attempt: input.attempt,
  ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
  id: input.id,
  jobId: input.jobId,
  pool: input.pool,
  revision: 0,
  state: {
    availableAt: input.at,
    kind: "queued",
    owner: input.owner,
    queuedAt: input.now,
  },
});

export const submission = (job: Job, run: Run): Change => ({
  facts: [
    { job, type: "job.submitted" },
    { run, type: "run.queued" },
  ],
  write: { jobs: [job], runs: [run] },
});

export const retrying = (job: Job, retry: Run): FollowUp => ({
  facts: [{ run: retry, type: "run.queued" }],
  jobs: [{ ...job, state: { kind: "pending" } }],
  runs: [retry],
});

export const failedJob = ({
  error,
  job,
  now,
  run,
}: {
  readonly error: ErrorShape;
  readonly job: Job;
  readonly now: Instant;
  readonly run: Run;
}): FollowUp => {
  const failed: Job = {
    ...job,
    state: { error, failedAt: now, kind: "failed", lastRunId: run.id },
  };
  return {
    facts: [{ job: failed, type: "job.settled" }],
    jobs: [failed],
    runs: [],
  };
};

export const failure = ({
  error,
  next,
  now,
  run,
}: {
  readonly error: ErrorShape;
  readonly next: FollowUp;
  readonly now: Instant;
  readonly run: Run;
}): Change => {
  const failed = bump(run, {
    error,
    failedAt: now,
    kind: "failed",
    retryable: next.runs.length > 0,
  });
  return {
    facts: [{ run: failed, type: "run.failed" }, ...next.facts],
    write: { jobs: next.jobs, runs: [failed, ...next.runs] },
  };
};

export const interruption = ({
  next,
  now,
  reason,
  run,
}: {
  readonly next: FollowUp;
  readonly now: Instant;
  readonly reason: string;
  readonly run: Run & { readonly state: { readonly kind: "running" } };
}): Change => {
  const interrupted = bump(run, {
    interruptedAt: now,
    kind: "interrupted",
    lease: run.state.lease,
    reason,
  });
  return {
    facts: [{ run: interrupted, type: "run.interrupted" }, ...next.facts],
    write: { jobs: next.jobs, runs: [interrupted, ...next.runs] },
  };
};

export const completion = ({
  job,
  now,
  output,
  run,
}: {
  readonly job: Job;
  readonly now: Instant;
  readonly output: JsonValue;
  readonly run: Run;
}): Change => {
  const done = bump(run, { completedAt: now, kind: "complete", output });
  const settled: Job = {
    ...job,
    state: { completedAt: now, kind: "complete", output, runId: run.id },
  };
  return {
    facts: [
      { run: done, type: "run.completed" },
      { job: settled, type: "job.settled" },
    ],
    write: { jobs: [settled], runs: [done] },
  };
};

export const suspending = ({
  job,
  now,
  opened,
  run,
  suspension,
}: {
  readonly job: Job;
  readonly now: Instant;
  readonly opened: boolean;
  readonly run: Run;
  readonly suspension: Suspension;
}): Change => {
  const suspended = bump(run, {
    kind: "suspended",
    suspendedAt: now,
    suspensionId: suspension.id,
  });
  return {
    facts: [
      { run: suspended, type: "run.suspended" },
      ...(opened ? [{ suspension, type: "suspension.opened" } as const] : []),
    ],
    write: {
      jobs: [
        {
          ...job,
          state: {
            kind: "suspended",
            runId: run.id,
            suspensionId: suspension.id,
          },
        },
      ],
      runs: [suspended],
      suspensions: opened ? [suspension] : [],
    },
  };
};

export const cancellation = ({
  job,
  now,
  reason,
  run,
  suspension,
}: {
  readonly job: Job;
  readonly now: Instant;
  readonly reason: string | undefined;
  readonly run: Run;
  readonly suspension: Suspension | undefined;
}): {
  readonly change: Change;
  readonly suspension: Suspension | undefined;
} => {
  const cancelled = { cancelledAt: now, kind: "cancelled", reason } as const;
  const cancelledRun = bump(run, cancelled);
  const cancelledJob: Job = { ...job, state: cancelled };
  const cancelledSuspension: Suspension | undefined =
    suspension?.state.kind === "pending"
      ? { ...suspension, revision: suspension.revision + 1, state: cancelled }
      : undefined;
  return {
    change: {
      facts: [
        ...(cancelledSuspension
          ? [
              {
                suspension: cancelledSuspension,
                type: "suspension.cancelled",
              } as const,
            ]
          : []),
        { run: cancelledRun, type: "run.cancelled" },
        { job: cancelledJob, type: "job.settled" },
      ],
      write: {
        jobs: [cancelledJob],
        runs: [cancelledRun],
        suspensions: cancelledSuspension ? [cancelledSuspension] : [],
      },
    },
    suspension: cancelledSuspension,
  };
};

export const suspensionCancellation = ({
  now,
  reason,
  suspension,
}: {
  readonly now: Instant;
  readonly reason: string | undefined;
  readonly suspension: Suspension;
}): { readonly change: Change; readonly suspension: Suspension } => {
  const cancelled: Suspension = {
    ...suspension,
    revision: suspension.revision + 1,
    state: { cancelledAt: now, kind: "cancelled", reason },
  };
  return {
    change: {
      facts: [{ suspension: cancelled, type: "suspension.cancelled" }],
      write: { suspensions: [cancelled] },
    },
    suspension: cancelled,
  };
};

export const starting = ({
  job,
  now,
  owner,
  run,
}: {
  readonly job: Job;
  readonly now: Instant;
  readonly owner: ProcessIdentity;
  readonly run: Run;
}): {
  readonly active: Job;
  readonly change: Change;
  readonly running: Run;
} => {
  const running = bump(
    { ...run, startedAt: run.startedAt ?? now },
    { kind: "running", lease: { claimedAt: now, owner } }
  );
  const active: Job = {
    ...job,
    state: { attempt: run.attempt, kind: "active", runId: run.id },
  };
  return {
    active,
    change: {
      facts: [{ run: running, type: "run.started" }],
      write: { jobs: [active], runs: [running] },
    },
    running,
  };
};

export const resolution = ({
  job,
  now,
  owner,
  run,
  value,
  suspension,
}: {
  readonly job: Job;
  readonly now: Instant;
  readonly owner: ProcessIdentity;
  readonly run: Run;
  readonly value: JsonValue;
  readonly suspension: Suspension;
}): { readonly change: Change; readonly resolved: Suspension } => {
  const resolved: Suspension = {
    ...suspension,
    revision: suspension.revision + 1,
    state: { kind: "resolved", resolvedAt: now, value },
  };
  const resumed = bump(run, {
    availableAt: now,
    kind: "queued",
    owner,
    queuedAt: now,
  });
  const live = run.state.kind === "suspended";
  return {
    change: {
      facts: [
        { suspension: resolved, type: "suspension.resolved" },
        ...(live ? [{ run: resumed, type: "run.resumed" } as const] : []),
      ],
      write: live
        ? {
            jobs: [{ ...job, state: { kind: "pending" } }],
            runs: [resumed],
            suspensions: [resolved],
          }
        : { suspensions: [resolved] },
    },
    resolved,
  };
};

export const removal = (
  job: Job,
  runs: readonly Run[],
  suspensions: readonly Suspension[]
): Change => ({
  facts: [],
  write: {
    deleteJobs: [job.id],
    deleteRuns: runs.map((run) => run.id),
    deleteSuspensions: suspensions.map((suspension) => suspension.id),
  },
});

export const claimOf = (
  run: Run,
  self: ProcessIdentity,
  gone: (owner: ProcessIdentity) => boolean
): "adopt" | "mine" | "skip" => {
  const owner = run.state.kind === "queued" ? run.state.owner : self;
  if (owner === undefined) {
    return "adopt";
  }
  if (sameProcess(owner, self)) {
    return "mine";
  }
  return gone(owner) ? "adopt" : "skip";
};
