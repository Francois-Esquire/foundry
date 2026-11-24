import { createTables } from "@foundry/lib/testing/sqlite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Effect, Layer, type Scope } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import type { QueueEvent, RunOutcome } from "../domain";
import { Queue } from "../queue";
import type { QueueService } from "../service";
import type { QueueWrite } from "../store/index";
import {
  makeSqliteQueueStore,
  type QueueDatabase,
  SqliteQueueStore,
  type SqliteQueueStoreOptions,
} from "../store/sqlite";
import { queueTables } from "../store/tables";

const clients: ReturnType<typeof createClient>[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
});

const openDatabase = async (): Promise<QueueDatabase> => {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  const database = drizzle(client);
  await createTables(database, queueTables);
  return database;
};

const handler = { name: "work" } as const;

const withSqliteQueue = <A, E>(
  options: SqliteQueueStoreOptions,
  body: (queue: QueueService) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Queue, body)).pipe(
      Effect.provide(
        Queue.layer().pipe(Layer.provide(SqliteQueueStore(options)))
      )
    )
  );

describe("SqliteQueueStore", () => {
  test("persists jobs, runs, suspensions, and pools so a new store instance reads them back", async () => {
    const database = await openDatabase();
    const events: QueueEvent["type"][] = [];
    const { promise: settled, resolve } = Promise.withResolvers<void>();
    const options: SqliteQueueStoreOptions = {
      database,
      onCommit: async (_transaction, write) => {
        events.push(...(write.events ?? []).map((event) => event.type));
        if (events.includes("job.settled")) {
          resolve();
        }
      },
      scope: "alpha",
    };
    const job = await withSqliteQueue(options, (queue) =>
      Effect.gen(function* () {
        yield* queue.register("work", () =>
          Effect.succeed<RunOutcome>({ kind: "complete", output: { n: 1 } })
        );
        yield* queue.configurePool({
          limit: Number.POSITIVE_INFINITY,
          name: "wide",
          state: "paused",
        });
        const submitted = yield* queue.submit({
          handler,
          policy: { idempotencyKey: "once" },
        });
        yield* Effect.promise(() => settled);
        return yield* queue.getJob(submitted.id);
      })
    );
    if (job === undefined) {
      throw new Error("job was not stored");
    }
    const reopened = makeSqliteQueueStore({ database, scope: "alpha" });
    const read = await Effect.runPromise(
      Effect.all({
        byKey: reopened.listJobs({ idempotencyKey: "once" }),
        job: reopened.getJob(job.id),
        pools: reopened.listPools,
        runs: reopened.listRuns({ jobId: job.id, state: "complete" }),
      })
    );
    expect(read.job).toEqual(job);
    expect(read.byKey.map((found) => found.id)).toEqual([job.id]);
    expect(read.runs).toHaveLength(1);
    expect(read.pools).toEqual([
      { limit: Number.POSITIVE_INFINITY, name: "wide", state: "paused" },
    ]);
    expect(events).toEqual([
      "job.submitted",
      "run.queued",
      "run.started",
      "run.completed",
      "job.settled",
    ]);
  });

  test("a commit whose onCommit hook fails writes nothing", async () => {
    const database = await openDatabase();
    const failing = makeSqliteQueueStore({
      database,
      onCommit: () => Promise.reject(new Error("outbox down")),
      scope: "alpha",
    });
    const write: QueueWrite = {
      jobs: [
        {
          createdAt: 0,
          handler,
          id: "jb-1",
          input: null,
          links: {},
          policy: {},
          pool: "default",
          state: { kind: "pending" },
        },
      ],
      runs: [
        {
          attempt: 1,
          id: "rn-1",
          jobId: "jb-1",
          pool: "default",
          revision: 0,
          state: { availableAt: 0, kind: "queued", queuedAt: 0 },
        },
      ],
    };
    const error = await Effect.runPromise(Effect.flip(failing.commit(write)));
    const plain = makeSqliteQueueStore({ database, scope: "alpha" });
    const after = await Effect.runPromise(
      Effect.all([plain.listJobs(), plain.listRuns()])
    );
    expect(error._tag).toBe("StoreError");
    expect(after).toEqual([[], []]);
  });

  test("stores in different scopes on one database never see each other's records", async () => {
    const database = await openDatabase();
    const job = await withSqliteQueue({ database, scope: "alpha" }, (queue) =>
      Effect.gen(function* () {
        yield* queue.register("work", () =>
          Effect.succeed<RunOutcome>({ kind: "complete", output: null })
        );
        return yield* queue.submit({
          handler,
          policy: { idempotencyKey: "k" },
        });
      })
    );
    const beta = makeSqliteQueueStore({ database, scope: "beta" });
    const seen = await Effect.runPromise(
      Effect.all([
        beta.getJob(job.id),
        beta.listJobs({ idempotencyKey: "k" }),
        beta.listRuns(),
      ])
    );
    expect(seen).toEqual([undefined, [], []]);
  });

  test("a commit deletes the named jobs, runs, and suspensions in its own scope only", async () => {
    const database = await openDatabase();
    const records: QueueWrite = {
      jobs: [
        {
          createdAt: 0,
          handler,
          id: "jb-1",
          input: null,
          links: {},
          policy: {},
          pool: "default",
          state: { cancelledAt: 0, kind: "cancelled" },
        },
      ],
      runs: [
        {
          attempt: 1,
          id: "rn-1",
          jobId: "jb-1",
          pool: "default",
          revision: 1,
          state: { cancelledAt: 0, kind: "cancelled" },
        },
      ],
      suspensions: [
        {
          id: "su-1",
          key: "approval",
          kind: "human",
          reason: "sign-off",
          request: null,
          revision: 1,
          runId: "rn-1",
          state: { cancelledAt: 0, kind: "cancelled" },
        },
      ],
    };
    const alpha = makeSqliteQueueStore({ database, scope: "alpha" });
    const beta = makeSqliteQueueStore({ database, scope: "beta" });
    const contents = (store: typeof alpha) =>
      Effect.all([store.listJobs(), store.listRuns(), store.listSuspensions()]);
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        yield* alpha.commit(records);
        yield* beta.commit(records);
        yield* alpha.commit({
          deleteJobs: ["jb-1"],
          deleteRuns: ["rn-1"],
          deleteSuspensions: ["su-1"],
        });
        return { alpha: yield* contents(alpha), beta: yield* contents(beta) };
      })
    );
    expect(after.alpha).toEqual([[], [], []]);
    expect(after.beta.map((rows) => rows.length)).toEqual([1, 1, 1]);
  });

  test("a commit writes and deletes more records than one statement can bind", async () => {
    const database = await openDatabase();
    const store = makeSqliteQueueStore({ database, scope: "bulk" });
    const count = 40_000;
    const runs = Array.from({ length: count }, (_, index) => ({
      attempt: 1,
      id: `rn-${String(index)}` as const,
      jobId: "jb-1" as const,
      pool: "default",
      revision: 0,
      state: { cancelledAt: 0, kind: "cancelled" as const },
    }));
    const counted = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.commit({ runs });
        const written = (yield* store.listRuns()).length;
        yield* store.commit({ deleteRuns: runs.map((run) => run.id) });
        return { left: (yield* store.listRuns()).length, written };
      })
    );
    expect(counted).toEqual({ left: 0, written: count });
  }, 60_000);
});
