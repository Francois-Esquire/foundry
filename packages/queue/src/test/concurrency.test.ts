import { Deferred, Effect, Layer, Ref, TestClock, TestContext } from "effect";
import { describe, expect, test } from "vitest";
import { createQueueClient } from "../client";
import { type RunOutcome, StoreError } from "../domain";
import { QueueStore, type QueueStoreService } from "../store/index";
import {
  awaitJob,
  flush,
  handler,
  sharedStore,
  withQueue,
} from "./helpers/queue";

const suspendOnce: () => Effect.Effect<RunOutcome> = () =>
  Effect.succeed({
    kind: "suspended",
    suspension: {
      key: "approval",
      kind: "human",
      reason: "ok?",
      request: null,
    },
  });

describe("Queue concurrency", () => {
  test("two queues racing to resolve one suspension settle it once and refuse the loser", async () => {
    const store = await sharedStore();
    const suspended = await Effect.runPromise(
      withQueue(store, { identity: { pid: 1, started: "a" } }, (queue) =>
        Effect.gen(function* () {
          yield* queue.register("work", suspendOnce);
          const job = yield* queue.submit({ handler });
          yield* awaitJob(queue, job.id, ["suspended"]);
          const [suspension] = yield* queue.listSuspensions();
          return suspension ?? (yield* Effect.dieMessage("not suspended"));
        })
      )
    );
    const bothRead = await Effect.runPromise(Deferred.make<void>());
    const reads = await Effect.runPromise(Ref.make(0));
    const gated: QueueStoreService = {
      ...store,
      commit: (write) =>
        Effect.zipRight(Deferred.await(bothRead), store.commit(write)),
      getSuspension: (id) =>
        Effect.tap(store.getSuspension(id), () =>
          Effect.flatMap(
            Ref.updateAndGet(reads, (n) => n + 1),
            (n) =>
              n >= 2 ? Deferred.succeed(bothRead, undefined) : Effect.void
          )
        ),
    };
    const resolver = (pid: number, value: string) =>
      withQueue(gated, { identity: { pid, started: "b" } }, (queue) =>
        Effect.either(queue.resolveSuspension(suspended.id, value))
      );
    const outcomes = await Effect.runPromise(
      Effect.all([resolver(2, "first"), resolver(3, "second")], {
        concurrency: "unbounded",
      })
    );
    const settled = await Effect.runPromise(store.getSuspension(suspended.id));
    expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual([
      "Left",
      "Right",
    ]);
    expect(
      outcomes.flatMap((outcome) =>
        outcome._tag === "Left" ? [outcome.left._tag] : []
      )
    ).toEqual(["SuspensionAlreadySettledError"]);
    expect(settled?.revision).toBe(1);
  });

  test("a settlement the store refuses once is retried, so drain ends with the job complete and the handler run once", async () => {
    const store = await sharedStore();
    const refused = await Effect.runPromise(Ref.make(false));
    const flaky: QueueStoreService = {
      ...store,
      commit: (write) =>
        Effect.flatMap(
          Ref.getAndSet(
            refused,
            write.runs?.some((run) => run.state.kind === "complete") ?? false
          ),
          (already) =>
            write.runs?.some((run) => run.state.kind === "complete") && !already
              ? Effect.fail(new StoreError({ cause: "disk full" }))
              : store.commit(write)
        ),
    };
    const result = await Effect.runPromise(
      withQueue(flaky, {}, (queue) =>
        Effect.gen(function* () {
          let calls = 0;
          yield* queue.register("work", () =>
            Effect.sync((): RunOutcome => {
              calls += 1;
              return { kind: "complete", output: calls };
            })
          );
          const job = yield* queue.submit({ handler });
          yield* flush;
          const draining = yield* Effect.fork(queue.drain());
          yield* TestClock.adjust(1000);
          yield* draining.await;
          return { calls, job: yield* queue.getJob(job.id) };
        })
      ).pipe(Effect.provide(TestContext.TestContext))
    );
    expect(result.calls).toBe(1);
    expect(result.job?.state).toMatchObject({ kind: "complete", output: 1 });
  });

  test("a settlement the store keeps refusing is given up, so drain ends and the run is left running for recovery", async () => {
    const store = await sharedStore();
    const refusing: QueueStoreService = {
      ...store,
      commit: (write) =>
        write.runs?.some((each) => each.state.kind === "complete")
          ? Effect.fail(new StoreError({ cause: "moved" }))
          : store.commit(write),
    };
    const result = await Effect.runPromise(
      withQueue(refusing, {}, (queue) =>
        Effect.gen(function* () {
          yield* queue.register("work", () =>
            Effect.succeed<RunOutcome>({ kind: "complete", output: null })
          );
          const job = yield* queue.submit({ handler });
          yield* flush;
          const draining = yield* Effect.fork(queue.drain());
          yield* TestClock.adjust(10_000);
          yield* draining.await;
          return {
            pools: yield* queue.pools,
            runs: yield* queue.listRuns({ jobId: job.id }),
          };
        })
      ).pipe(Effect.provide(TestContext.TestContext))
    );
    expect(result.runs.map((run) => run.state.kind)).toEqual(["running"]);
    expect(result.pools).toEqual([]);
  });

  test("a plain async handler persists the checkpoint it awaits and sees a refused save as a rejection", async () => {
    const store = await sharedStore();
    const client = createQueueClient({
      store: Layer.succeed(QueueStore, {
        ...store,
        commit: (write) =>
          write.runs?.some((each) => each.checkpoint === "refused")
            ? Effect.fail(new StoreError({ cause: "refused" }))
            : store.commit(write),
      }),
    });
    await client.register("work", async (context) => {
      await context.saveCheckpoint("kept");
      const refusal = await Promise.resolve(
        context.saveCheckpoint("refused")
      ).then(
        () => "saved",
        (error: unknown) => (error instanceof StoreError ? error._tag : "other")
      );
      return { kind: "complete", output: refusal };
    });
    const job = await client.submit({ handler });
    await client.drain();
    const [run] = await client.listRuns({ jobId: job.id });
    const settled = await client.getJob(job.id);
    await client.dispose();
    expect(run?.checkpoint).toBe("kept");
    expect(settled?.state).toMatchObject({
      kind: "complete",
      output: "StoreError",
    });
  });
});
