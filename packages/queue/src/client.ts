import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Stream,
} from "effect";
import type { ErrorShape, QueueEvent, RunOutcome } from "./domain";
import { Queue } from "./queue";
import type {
  QueueOptions,
  QueueService,
  RunContext,
  RunHandler,
} from "./service";
import type { QueueStore } from "./store/index";
import { MemoryQueueStore } from "./store/memory";

export type QueueHandler = (
  context: RunContext
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
  extends Omit<Promised<QueueService>, "events" | "register"> {
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

const lifted =
  (handler: QueueHandler): RunHandler =>
  (context) =>
    Effect.flatMap(
      Effect.try({ catch: errorShapeOf, try: () => handler(context) }),
      (result) =>
        Effect.isEffect(result)
          ? result
          : Effect.tryPromise({
              catch: errorShapeOf,
              try: async () => await result,
            })
    );

export const createQueueClient = (
  options: QueueClientOptions = {}
): QueueClient => {
  const { store = MemoryQueueStore, ...queueOptions } = options;
  const runtime = ManagedRuntime.make(
    Queue.layer(queueOptions).pipe(Layer.provide(store))
  );
  const use = async <A, E>(
    operation: (queue: QueueService) => Effect.Effect<A, E>
  ): Promise<A> => {
    const exit = await runtime.runPromiseExit(Effect.flatMap(Queue, operation));
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    throw Cause.squash(exit.cause);
  };

  return {
    abandon: (id, error) => use((queue) => queue.abandon(id, error)),
    adopt: (id) => use((queue) => queue.adopt(id)),
    cancel: (id, reason) => use((queue) => queue.cancel(id, reason)),
    cancelSuspension: (suspensionId, reason) =>
      use((queue) => queue.cancelSuspension(suspensionId, reason)),
    configurePool: (pool) => use((queue) => queue.configurePool(pool)),
    dispose: () => runtime.dispose(),
    drain: (graceMs) => use((queue) => queue.drain(graceMs)),
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
      const fiber = runtime.runFork(
        Stream.runForEach(
          Stream.unwrap(Effect.map(Queue, (queue) => queue.events)),
          (event) => Effect.sync(() => listener(event))
        )
      );
      return () => {
        runtime.runFork(Fiber.interrupt(fiber));
      };
    },
  };
};
