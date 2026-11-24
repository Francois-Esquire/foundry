import { createTables } from "@foundry/lib/testing/sqlite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Effect, Layer, type Scope } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import type { QueueEvent, RunOutcome } from "../domain";
import { Queue, type QueueService } from "../queue";
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
  test("persists jobs, runs, waits, and pools so a new store instance reads them back", async () => {
    const database = await openDatabase();
    const events: QueueEvent["type"][] = [];
    const { promise: settled, resolve } = Promise.withResolvers<void>();
    const options: SqliteQueueStoreOptions = {
      database,
      onCommit: async (_transaction, write) => {
        events.push(...(write.events ?? []).map((event) => event.type));
        if (events.includes("JobSettled")) {
          resolve();
        }
      },
      scope: "alpha",
    };
    const job = await withSqliteQueue(options, (queue) =>
      Effect.gen(function* () {
        yield* queue.register("work", () =>
          Effect.succeed<RunOutcome>({ kind: "completed", output: { n: 1 } })
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
        runs: reopened.listRuns({ jobId: job.id, state: "completed" }),
      })
    );
    expect(read.job).toEqual(job);
    expect(read.byKey.map((found) => found.id)).toEqual([job.id]);
    expect(read.runs).toHaveLength(1);
    expect(read.pools).toEqual([
      { limit: Number.POSITIVE_INFINITY, name: "wide", state: "paused" },
    ]);
    expect(events).toEqual([
      "JobSubmitted",
      "RunQueued",
      "RunStarted",
      "RunCompleted",
      "JobSettled",
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
          Effect.succeed<RunOutcome>({ kind: "completed", output: null })
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
});
