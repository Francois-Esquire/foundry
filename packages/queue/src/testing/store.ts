import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type {
  ConcurrencyPool,
  Job,
  JobId,
  Run,
  RunId,
  Suspension,
  SuspensionId,
} from "../domain";
import type { QueueStoreService, QueueWrite } from "../store/index";

type Open = () => QueueStoreService | Promise<QueueStoreService>;

export interface QueueStoreCapabilities {
  readonly watermark?: boolean;
}

export function describeQueueStore(
  name: string,
  open: Open,
  capabilities: QueueStoreCapabilities = {}
): void {
  const watermark = capabilities.watermark ?? true;
  describe(`${name} queue store conformance`, () => {
    describeReads(open, watermark);
    if (watermark) {
      describeWatermark(open);
    }
    describeRevisions(open);
    describeIdempotency(open);
    describeDeletes(open);
  });
}

function describeReads(open: Open, watermark: boolean): void {
  test("an empty store holds no records and a zero watermark", async () => {
    const store = await open();
    const base = await read(
      Effect.all({
        job: store.getJob("jb-missing"),
        jobs: store.listJobs(),
        pools: store.listPools,
        run: store.getRun("rn-missing"),
        runs: store.listRuns(),
        suspension: store.getSuspension("su-missing"),
        suspensions: store.listSuspensions(),
      })
    );
    expect(base).toEqual({
      job: undefined,
      jobs: [],
      pools: [],
      run: undefined,
      runs: [],
      suspension: undefined,
      suspensions: [],
    });
    if (watermark) {
      expect(await read(store.watermark)).toBe(0);
    }
  });

  test("a commit puts jobs, runs, suspensions, and pools that reads return whole", async () => {
    const store = await open();
    await read(store.commit(SEEDED));

    expect(
      await read(
        Effect.all({
          job: store.getJob(KEYED_JOB.id),
          jobs: Effect.map(store.listJobs(), byId),
          pools: Effect.map(store.listPools, byName),
          run: store.getRun(DONE_RUN.id),
          runs: Effect.map(store.listRuns(), byId),
          suspension: store.getSuspension(PENDING_SUSPENSION.id),
          suspensions: Effect.map(store.listSuspensions(), byId),
        })
      )
    ).toEqual({
      job: KEYED_JOB,
      jobs: byId(SEEDED.jobs),
      pools: byName(SEEDED.pools),
      run: DONE_RUN,
      runs: byId(SEEDED.runs),
      suspension: PENDING_SUSPENSION,
      suspensions: byId(SEEDED.suspensions),
    });
  });

  test("a commit over a stored record replaces it", async () => {
    const store = await open();
    await read(store.commit(SEEDED));
    const settled = job("jb-pending", {
      state: { cancelledAt: 5, kind: "cancelled", reason: "stop" },
    });
    const resized: ConcurrencyPool = {
      limit: 4,
      name: "wide",
      state: "active",
    };
    await read(store.commit({ jobs: [settled], pools: [resized] }));

    expect(await read(store.getJob(settled.id))).toEqual(settled);
    expect(byName(await read(store.listPools))).toEqual(
      byName([resized, NARROW_POOL])
    );
  });

  test("list filters select jobs, runs, and suspensions by key, owner, and state", async () => {
    const store = await open();
    await read(store.commit(SEEDED));

    expect(
      await read(
        Effect.all({
          jobsByKey: store.listJobs({ idempotencyKey: "once" }),
          jobsByMissingKey: store.listJobs({ idempotencyKey: "never" }),
          jobsByState: store.listJobs({ state: "pending" }),
          runsByJob: store.listRuns({ jobId: KEYED_JOB.id }),
          runsByJobAndState: store.listRuns({
            jobId: KEYED_JOB.id,
            state: "complete",
          }),
          runsByState: store.listRuns({ state: "queued" }),
          suspensionsByRun: store.listSuspensions({ runId: DONE_RUN.id }),
          suspensionsByRunAndState: store.listSuspensions({
            runId: QUEUED_RUN.id,
            state: "resolved",
          }),
          suspensionsByState: store.listSuspensions({ state: "pending" }),
        })
      ).then((lists) =>
        Object.fromEntries(
          Object.entries(lists).map(([key, list]) => [key, ids(list)])
        )
      )
    ).toEqual({
      jobsByKey: [KEYED_JOB.id],
      jobsByMissingKey: [],
      jobsByState: [PENDING_JOB.id],
      runsByJob: [DONE_RUN.id, FAILED_RUN.id],
      runsByJobAndState: [DONE_RUN.id],
      runsByState: [QUEUED_RUN.id],
      suspensionsByRun: [RESOLVED_SUSPENSION.id],
      suspensionsByRunAndState: [],
      suspensionsByState: [PENDING_SUSPENSION.id],
    });
  });
}

function describeWatermark(open: Open): void {
  test("each commit raises the watermark, and a refused commit leaves it", async () => {
    const store = await open();
    const first = run("rn-1", "jb-1");
    await read(store.commit({ runs: [first] }));
    const afterFirst = await read(store.watermark);
    await read(store.commit({ jobs: [job("jb-1")] }));
    const afterSecond = await read(store.watermark);
    await refusal(
      store.commit({
        expected: { runs: [{ id: first.id, revision: null }] },
        runs: [{ ...first, revision: 1 }],
      })
    );

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(2);
    expect(await read(store.watermark)).toBe(2);
  });
}

function describeRevisions(open: Open): void {
  test("a commit expecting a run revision the store holds lands", async () => {
    const store = await open();
    const fresh = run("rn-1", "jb-1");
    await read(
      store.commit({
        expected: { runs: [{ id: fresh.id, revision: null }] },
        runs: [fresh],
      })
    );
    const next = { ...fresh, revision: 1 };
    await read(
      store.commit({
        expected: { runs: [{ id: fresh.id, revision: 0 }] },
        runs: [next],
      })
    );

    expect(await read(store.getRun(fresh.id))).toEqual(next);
  });

  test("a commit expecting a run revision the store does not hold is refused and writes nothing", async () => {
    const store = await open();
    const stored = run("rn-1", "jb-1");
    await read(store.commit({ runs: [stored] }));

    const error = await refusal(
      store.commit({
        expected: { runs: [{ id: stored.id, revision: null }] },
        jobs: [job("jb-new")],
        runs: [{ ...stored, revision: 1 }],
      })
    );

    expect(error).toMatchObject({ _tag: "WriteConflictError", id: stored.id });
    expect(await read(store.getRun(stored.id))).toEqual(stored);
    expect(await read(store.getJob("jb-new"))).toBeUndefined();
  });

  test("a commit expecting a suspension revision the store does not hold is refused and writes nothing", async () => {
    const store = await open();
    const stored = suspension("su-1", "rn-1");
    await read(store.commit({ suspensions: [stored] }));

    const error = await refusal(
      store.commit({
        expected: { suspensions: [{ id: stored.id, revision: 3 }] },
        runs: [run("rn-new", "jb-1")],
        suspensions: [
          {
            ...stored,
            revision: 4,
            state: { kind: "resolved", resolvedAt: 9, value: "late" },
          },
        ],
      })
    );

    expect(error).toMatchObject({ _tag: "WriteConflictError", id: stored.id });
    expect(await read(store.getSuspension(stored.id))).toEqual(stored);
    expect(await read(store.getRun("rn-new"))).toBeUndefined();
  });

  test("a commit expecting a record to be absent is refused once it exists", async () => {
    const store = await open();
    const stored = suspension("su-1", "rn-1");
    await read(store.commit({ suspensions: [stored] }));

    const error = await refusal(
      store.commit({
        expected: { suspensions: [{ id: stored.id, revision: null }] },
        suspensions: [{ ...stored, reason: "again" }],
      })
    );

    expect(error).toMatchObject({ _tag: "WriteConflictError", id: stored.id });
    expect(await read(store.getSuspension(stored.id))).toEqual(stored);
  });
}

function describeIdempotency(open: Open): void {
  test("a job whose idempotency key another job holds is refused and writes nothing", async () => {
    const store = await open();
    const holder = job("jb-1", { policy: { idempotencyKey: "once" } });
    await read(store.commit({ jobs: [holder] }));

    const error = await refusal(
      store.commit({
        jobs: [job("jb-2", { policy: { idempotencyKey: "once" } })],
        runs: [run("rn-2", "jb-2")],
      })
    );

    expect(error).toMatchObject({ _tag: "WriteConflictError", id: "jb-2" });
    expect(ids(await read(store.listJobs()))).toEqual([holder.id]);
    expect(await read(store.listRuns())).toEqual([]);
  });

  test("two jobs in one write sharing an idempotency key are refused", async () => {
    const store = await open();

    const error = await refusal(
      store.commit({
        jobs: [
          job("jb-1", { policy: { idempotencyKey: "once" } }),
          job("jb-2", { policy: { idempotencyKey: "once" } }),
        ],
      })
    );

    expect(error).toMatchObject({ _tag: "WriteConflictError" });
    expect(await read(store.listJobs())).toEqual([]);
  });

  test("a job rewritten under the idempotency key it holds lands", async () => {
    const store = await open();
    const holder = job("jb-1", { policy: { idempotencyKey: "once" } });
    await read(store.commit({ jobs: [holder] }));
    const settled = job("jb-1", {
      policy: { idempotencyKey: "once" },
      state: { cancelledAt: 1, kind: "cancelled" },
    });
    await read(store.commit({ jobs: [settled] }));

    expect(await read(store.listJobs({ idempotencyKey: "once" }))).toEqual([
      settled,
    ]);
  });
}

function describeDeletes(open: Open): void {
  test("deletes remove only the named jobs, runs, and suspensions, and missing ids are no-ops", async () => {
    const store = await open();
    await read(store.commit(SEEDED));
    await read(
      store.commit({
        deleteJobs: [PENDING_JOB.id, "jb-missing"],
        deleteRuns: [FAILED_RUN.id, "rn-missing"],
        deleteSuspensions: [PENDING_SUSPENSION.id, "su-missing"],
      })
    );

    expect(
      await read(
        Effect.all({
          deletedJob: store.getJob(PENDING_JOB.id),
          jobs: store.listJobs(),
          pools: Effect.map(store.listPools, byName),
          runs: Effect.map(store.listRuns(), byId),
          suspensions: store.listSuspensions(),
        })
      )
    ).toEqual({
      deletedJob: undefined,
      jobs: [KEYED_JOB],
      pools: byName(SEEDED.pools),
      runs: byId([DONE_RUN, QUEUED_RUN]),
      suspensions: [RESOLVED_SUSPENSION],
    });
  });
}

function read<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

function refusal<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(Effect.flip(effect));
}

function byId<T extends { readonly id: string }>(
  records: readonly T[] | undefined
): T[] {
  return [...(records ?? [])].sort((a, b) => a.id.localeCompare(b.id));
}

function byName(
  pools: readonly ConcurrencyPool[] | undefined
): ConcurrencyPool[] {
  return [...(pools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
}

function ids(records: readonly { readonly id: string }[]): string[] {
  return byId(records).map((record) => record.id);
}

function job(id: JobId, overrides: Partial<Job> = {}): Job {
  return {
    createdAt: 0,
    handler: { name: "work" },
    id,
    input: null,
    links: {},
    policy: {},
    pool: "default",
    state: { kind: "pending" },
    ...overrides,
  };
}

function run(id: RunId, jobId: JobId, overrides: Partial<Run> = {}): Run {
  return {
    attempt: 1,
    id,
    jobId,
    pool: "default",
    revision: 0,
    state: { availableAt: 0, kind: "queued", queuedAt: 0 },
    ...overrides,
  };
}

function suspension(
  id: SuspensionId,
  runId: RunId,
  overrides: Partial<Suspension> = {}
): Suspension {
  return {
    id,
    key: "approval",
    kind: "human",
    reason: "sign-off",
    request: null,
    revision: 0,
    runId,
    state: { createdAt: 0, kind: "pending" },
    ...overrides,
  };
}

const KEYED_JOB = job("jb-keyed", {
  input: { nested: { list: [1, "two", null, true] } },
  links: { source: "conformance", tags: { team: "queue" } },
  policy: {
    idempotencyKey: "once",
    retry: { backoff: { delayMs: 10, kind: "fixed" }, maxAttempts: 3 },
  },
  state: {
    completedAt: 7,
    kind: "complete",
    output: { n: 1 },
    runId: "rn-done",
  },
});

const PENDING_JOB = job("jb-pending", { pool: "narrow" });

const DONE_RUN = run("rn-done", KEYED_JOB.id, {
  attempt: 2,
  checkpoint: { step: 3 },
  startedAt: 4,
  state: { completedAt: 7, kind: "complete", output: { n: 1 } },
});

const FAILED_RUN = run("rn-failed", KEYED_JOB.id, {
  revision: 2,
  state: {
    error: { message: "boom", name: "Error" },
    failedAt: 3,
    kind: "failed",
    retryable: true,
  },
});

const QUEUED_RUN = run("rn-queued", PENDING_JOB.id, { pool: "narrow" });

const PENDING_SUSPENSION = suspension("su-pending", QUEUED_RUN.id, {
  request: { question: "ship it?" },
});

const RESOLVED_SUSPENSION = suspension("su-resolved", DONE_RUN.id, {
  revision: 1,
  state: { kind: "resolved", resolvedAt: 6, value: { approved: true } },
});

const NARROW_POOL: ConcurrencyPool = {
  limit: 2,
  name: "narrow",
  state: "active",
};

const SEEDED = {
  jobs: [KEYED_JOB, PENDING_JOB],
  pools: [
    { limit: Number.POSITIVE_INFINITY, name: "wide", state: "paused" },
    NARROW_POOL,
  ],
  runs: [DONE_RUN, FAILED_RUN, QUEUED_RUN],
  suspensions: [PENDING_SUSPENSION, RESOLVED_SUSPENSION],
} satisfies QueueWrite;
