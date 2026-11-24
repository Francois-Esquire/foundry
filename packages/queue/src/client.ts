import type { JsonValue } from "@foundry/lib/json";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Stream,
} from "effect";
import type { Failure, QueueEvent, RunOutcome } from "./domain";
import {
  Queue,
  type QueueOptions,
  type QueueService,
  type RunContext,
} from "./queue";
import type { QueueStore } from "./store/index";
import { MemoryQueueStore } from "./store/memory";

export interface PlainRunContext extends Omit<RunContext, "saveCheckpoint"> {
  readonly saveCheckpoint: (value: JsonValue) => Promise<void>;
}

export type PlainRunHandler = (
  context: PlainRunContext
) => Promise<RunOutcome> | RunOutcome;

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
  register(name: string, handler: PlainRunHandler): Promise<void>;
  subscribe(listener: (event: QueueEvent) => void): () => void;
}

const failureOf = (error: unknown): Failure =>
  error instanceof Error
    ? {
        code: "error",
        message: error.message,
        ...(error.stack === undefined ? {} : { stack: error.stack }),
      }
    : { code: "error", message: String(error) };

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
    cancel: (id, reason) => use((queue) => queue.cancel(id, reason)),
    cancelWait: (waitId, reason) =>
      use((queue) => queue.cancelWait(waitId, reason)),
    configurePool: (pool) => use((queue) => queue.configurePool(pool)),
    dispose: () => runtime.dispose(),
    drain: (graceMs) => use((queue) => queue.drain(graceMs)),
    getJob: (id) => use((queue) => queue.getJob(id)),
    getRun: (id) => use((queue) => queue.getRun(id)),
    getWait: (id) => use((queue) => queue.getWait(id)),
    listJobs: (filter) => use((queue) => queue.listJobs(filter)),
    listRuns: (filter) => use((queue) => queue.listRuns(filter)),
    listWaits: (filter) => use((queue) => queue.listWaits(filter)),
    pause: () => use((queue) => queue.pause),
    pools: () => use((queue) => queue.pools),
    recover: (recoverOptions) => use((queue) => queue.recover(recoverOptions)),
    register: (name, handler) =>
      use((queue) =>
        queue.register(name, (context) =>
          Effect.tryPromise({
            catch: failureOf,
            try: async () =>
              await handler({
                ...context,
                saveCheckpoint: (value) =>
                  use(() => context.saveCheckpoint(value)),
              }),
          })
        )
      ),
    resolveWait: (waitId, value) =>
      use((queue) => queue.resolveWait(waitId, value)),
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
