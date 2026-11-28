import type { JsonValue } from "@foundry/lib/json";
import {
  Cause,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Scope,
  Stream,
} from "effect";
import type { ErrorShape, QueueError, QueueEvent, RunOutcome } from "./domain";
import { Queue } from "./queue";
import type {
  QueueOptions,
  QueueService,
  RunContext,
  RunHandler,
} from "./service";
import type { QueueStore } from "./store/index";
import { MemoryQueueStore } from "./store/memory";

export type Checkpointing = Effect.Effect<void, QueueError> & PromiseLike<void>;

export interface QueueHandlerContext
  extends Omit<RunContext, "saveCheckpoint"> {
  readonly saveCheckpoint: (value: JsonValue) => Checkpointing;
}

export type QueueHandler = (
  context: QueueHandlerContext
) => Effect.Effect<RunOutcome, ErrorShape> | Promise<RunOutcome> | RunOutcome;

export interface QueueClientOptions extends QueueOptions {
  readonly store?: Layer.Layer<QueueStore>;
}

type Promised<Service> = {
  readonly [Key in keyof Service]: Service[Key] extends (
    ...args: infer Args
  ) => Effect.Effect<infer Value, unknown, unknown>
    ? (...args: Args) => Promise<Value>
    : Service[Key] extends Effect.Effect<infer Value, unknown, unknown>
      ? () => Promise<Value>
      : never;
};

export interface QueueClient
  extends Omit<Promised<QueueService>, "register" | "subscribe"> {
  dispose(): Promise<void>;
  register(name: string, handler: QueueHandler): Promise<void>;
  subscribe(listener: (event: QueueEvent) => void): () => void;
}

const errorShapeOf = (error: unknown): ErrorShape =>
  error instanceof Error
    ? {
        message: error.message,
        name: error.name,
        ...(error.stack === undefined ? {} : { stack: error.stack }),
      }
    : { message: String(error), name: "Error" };

const settledValue = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

export const createQueueClient = (
  options: QueueClientOptions = {}
): QueueClient => {
  const { store = MemoryQueueStore, ...queueOptions } = options;
  const runtime = ManagedRuntime.make(
    Queue.layer(queueOptions).pipe(Layer.provide(store))
  );
  const listeners = new Set<(event: QueueEvent) => void>();
  const fanOut = Effect.runSync(Scope.make());
  const announce = (event: QueueEvent) =>
    Effect.forEach(
      [...listeners],
      (listener) =>
        Effect.try(() => listener(event)).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("queue listener failed", error)
          )
        ),
      { discard: true }
    );
  const ready = runtime.runPromiseExit(
    Effect.flatMap(Queue, (queue) =>
      Effect.flatMap(Scope.extend(queue.subscribe, fanOut), (events) =>
        Effect.forkIn(Stream.runForEach(events, announce), fanOut)
      )
    )
  );
  const run = async <A, E>(effect: Effect.Effect<A, E, Queue>): Promise<A> => {
    settledValue(await ready);
    return settledValue(await runtime.runPromiseExit(effect));
  };
  const use = <A, E>(
    operation: (queue: QueueService) => Effect.Effect<A, E>
  ): Promise<A> => run(Effect.flatMap(Queue, operation));

  const checkpointing = (saving: Effect.Effect<void, QueueError>) => {
    let started: Promise<void> | undefined;
    const awaited = (): Promise<void> => {
      started ??= run(saving);
      return started;
    };
    const awaitable: PromiseLike<void> = {
      // biome-ignore lint/suspicious/noThenProperty: a saved checkpoint is awaitable from plain handlers and yieldable from Effect handlers.
      then: (onFulfilled, onRejected) =>
        awaited().then(onFulfilled, onRejected),
    };
    return Object.assign(
      Effect.suspend(() => saving),
      awaitable
    );
  };

  const lifted =
    (handler: QueueHandler): RunHandler =>
    (context) =>
      Effect.flatMap(
        Effect.try({
          catch: errorShapeOf,
          try: () =>
            handler({
              ...context,
              saveCheckpoint: (value) =>
                checkpointing(context.saveCheckpoint(value)),
            }),
        }),
        (result) =>
          Effect.isEffect(result)
            ? result
            : Effect.tryPromise({
                catch: errorShapeOf,
                try: async () => await result,
              })
      );

  return {
    abandon: (id, error) => use((queue) => queue.abandon(id, error)),
    awaitJob: (id) => use((queue) => queue.awaitJob(id)),
    cancel: (id, reason) => use((queue) => queue.cancel(id, reason)),
    cancelSuspension: (suspensionId, reason) =>
      use((queue) => queue.cancelSuspension(suspensionId, reason)),
    configurePool: (pool) => use((queue) => queue.configurePool(pool)),
    dispose: async () => {
      await Effect.runPromise(Scope.close(fanOut, Exit.void));
      await runtime.dispose();
    },
    drain: (graceMs) => use((queue) => queue.drain(graceMs)),
    drainUntilIdle: (graceMs) => use((queue) => queue.drainUntilIdle(graceMs)),
    getJob: (id) => use((queue) => queue.getJob(id)),
    getRun: (id) => use((queue) => queue.getRun(id)),
    getSuspension: (id) => use((queue) => queue.getSuspension(id)),
    listJobs: (filter) => use((queue) => queue.listJobs(filter)),
    listRuns: (filter) => use((queue) => queue.listRuns(filter)),
    listSuspensions: (filter) => use((queue) => queue.listSuspensions(filter)),
    pause: () => use((queue) => queue.pause),
    pools: () => use((queue) => queue.pools),
    recover: (recoverOptions) => use((queue) => queue.recover(recoverOptions)),
    register: (name, handler) =>
      use((queue) => queue.register(name, lifted(handler))),
    removeJob: (id) => use((queue) => queue.removeJob(id)),
    resolveSuspension: (suspensionId, value, resolveOptions) =>
      use((queue) =>
        queue.resolveSuspension(suspensionId, value, resolveOptions)
      ),
    resume: () => use((queue) => queue.resume),
    retire: (successor) => use((queue) => queue.retire(successor)),
    submit: (input) => use((queue) => queue.submit(input)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
