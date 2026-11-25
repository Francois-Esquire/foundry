import {
  Cause,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Scope,
  Stream,
} from "effect";
import type { ScheduleDispatch } from "./dispatch";
import type { ScheduleEvent } from "./domain";
import {
  Scheduler,
  type SchedulerOptions,
  type SchedulerService,
} from "./scheduler";
import type { ScheduleStore } from "./store/index";
import { MemoryScheduleStore } from "./store/memory";

export interface SchedulerClientOptions extends SchedulerOptions {
  readonly dispatch: Layer.Layer<ScheduleDispatch>;
  readonly store?: Layer.Layer<ScheduleStore>;
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

export interface SchedulerClient
  extends Omit<Promised<SchedulerService>, "subscribe"> {
  dispose(): Promise<void>;
  subscribe(listener: (event: ScheduleEvent) => void): () => void;
}

const settledValue = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

export const createSchedulerClient = (
  options: SchedulerClientOptions
): SchedulerClient => {
  const {
    dispatch,
    store = MemoryScheduleStore,
    ...schedulerOptions
  } = options;
  const runtime = ManagedRuntime.make(
    Scheduler.layer(schedulerOptions).pipe(
      Layer.provide(Layer.merge(dispatch, store))
    )
  );
  const listeners = new Set<(event: ScheduleEvent) => void>();
  const fanOut = Effect.runSync(Scope.make());
  const announce = (event: ScheduleEvent) =>
    Effect.forEach(
      [...listeners],
      (listener) =>
        Effect.try(() => listener(event)).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("schedule listener failed", error)
          )
        ),
      { discard: true }
    );
  const ready = runtime.runPromiseExit(
    Effect.flatMap(Scheduler, (scheduler) =>
      Effect.flatMap(Scope.extend(scheduler.subscribe, fanOut), (events) =>
        Effect.forkIn(Stream.runForEach(events, announce), fanOut)
      )
    )
  );
  const use = async <A, E>(
    operation: (scheduler: SchedulerService) => Effect.Effect<A, E>
  ): Promise<A> => {
    settledValue(await ready);
    return settledValue(
      await runtime.runPromiseExit(Effect.flatMap(Scheduler, operation))
    );
  };

  return {
    cursor: (id) => use((scheduler) => scheduler.cursor(id)),
    dispose: async () => {
      await Effect.runPromise(Scope.close(fanOut, Exit.void));
      await runtime.dispose();
    },
    get: (id) => use((scheduler) => scheduler.get(id)),
    latestOccurrence: (id) =>
      use((scheduler) => scheduler.latestOccurrence(id)),
    list: () => use((scheduler) => scheduler.list),
    pause: (id) => use((scheduler) => scheduler.pause(id)),
    register: (input) => use((scheduler) => scheduler.register(input)),
    resume: (id) => use((scheduler) => scheduler.resume(id)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    tick: () => use((scheduler) => scheduler.tick),
    triggerNow: (id) => use((scheduler) => scheduler.triggerNow(id)),
    unregister: (id) => use((scheduler) => scheduler.unregister(id)),
  };
};
