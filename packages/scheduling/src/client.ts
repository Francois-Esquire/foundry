import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
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
  extends Omit<Promised<SchedulerService>, "events"> {
  dispose(): Promise<void>;
  subscribe(listener: (event: ScheduleEvent) => void): () => void;
}

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
  const use = async <A, E>(
    operation: (scheduler: SchedulerService) => Effect.Effect<A, E>
  ): Promise<A> => {
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(Scheduler, operation)
    );
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    throw Cause.squash(exit.cause);
  };

  return {
    cursor: (id) => use((scheduler) => scheduler.cursor(id)),
    dispose: () => runtime.dispose(),
    get: (id) => use((scheduler) => scheduler.get(id)),
    list: () => use((scheduler) => scheduler.list),
    pause: (id) => use((scheduler) => scheduler.pause(id)),
    register: (input) => use((scheduler) => scheduler.register(input)),
    resume: (id) => use((scheduler) => scheduler.resume(id)),
    subscribe: (listener) => {
      const fiber = runtime.runFork(
        Stream.runForEach(
          Stream.unwrap(Effect.map(Scheduler, (scheduler) => scheduler.events)),
          (event) => Effect.sync(() => listener(event))
        )
      );
      return () => {
        runtime.runFork(Fiber.interrupt(fiber));
      };
    },
    tick: () => use((scheduler) => scheduler.tick),
    triggerNow: (id) => use((scheduler) => scheduler.triggerNow(id)),
    unregister: (id) => use((scheduler) => scheduler.unregister(id)),
  };
};
