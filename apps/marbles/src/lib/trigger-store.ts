import {
  CursorConflictError,
  ScheduleConflictError,
  StoreError,
} from "@foundry/scheduling";
import type { ScheduleStoreService } from "@foundry/scheduling/store";
import { makeMemoryScheduleStore } from "@foundry/scheduling/store/memory";
import { Cause, Effect, Exit } from "effect";
import { z } from "zod";

import { RecordsGate } from "~/lib/events/records-gate";
import { storableJson } from "~/lib/json-data";
import type { Launch } from "~/lib/launch";

export interface TriggerStore {
  clearPendingLaunch(key: string): Promise<void>;
  close(): Promise<void>;
  forgetMonitor(key: string): Promise<void>;
  monitorState(key: string): Promise<MonitorState | undefined>;
  saveMonitorState(key: string, state: MonitorState): Promise<void>;
  schedules(): Promise<ScheduleStoreService>;
}

const launchSchema = z.object({
  input: z.unknown(),
  workflow: z.string(),
});

export const monitorStateSchema = z.object({
  observed: z.record(z.string(), z.unknown()),
  pending: launchSchema.optional(),
});

export interface MonitorState {
  readonly observed: Readonly<Record<string, unknown>>;
  readonly pending?: Launch;
}

export function storedMonitorState(
  key: string,
  { observed, pending }: MonitorState
): MonitorState {
  const at = `monitor ${JSON.stringify(key)}`;
  return monitorStateSchema.parse({
    observed: storableJson(`${at} observed`, observed),
    ...(pending === undefined
      ? {}
      : {
          pending: {
            input: storableJson(`${at} pending input`, pending.input),
            workflow: pending.workflow,
          },
        }),
  }) as MonitorState;
}

const settled = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

export function gatedScheduleStore(
  store: ScheduleStoreService,
  around: <T>(call: () => Promise<T>) => Promise<T>
): ScheduleStoreService {
  const through = <A>(effect: Effect.Effect<A, StoreError>) =>
    Effect.tryPromise({
      catch: (cause) =>
        cause instanceof StoreError ? cause : new StoreError({ cause }),
      try: () => around(() => settled(effect)),
    });
  const guarded = (
    effect: Effect.Effect<
      void,
      StoreError | CursorConflictError | ScheduleConflictError
    >
  ) =>
    Effect.tryPromise({
      catch: (cause) =>
        cause instanceof StoreError ||
        cause instanceof CursorConflictError ||
        cause instanceof ScheduleConflictError
          ? cause
          : new StoreError({ cause }),
      try: () => around(() => settled(effect)),
    });
  return {
    claim: (occurrence, replacing, exclusive) =>
      through(store.claim(occurrence, replacing, exclusive)),
    commit: (write) => guarded(store.commit(write)),
    getCursor: (id) => through(store.getCursor(id)),
    getOccurrence: (id) => through(store.getOccurrence(id)),
    getSchedule: (id) => through(store.getSchedule(id)),
    latestOccurrence: (id) => through(store.latestOccurrence(id)),
    listOccurrences: (filter) => through(store.listOccurrences(filter)),
    listSchedules: Effect.suspend(() => through(store.listSchedules)),
    releaseClaim: (id, owner) => through(store.releaseClaim(id, owner)),
  };
}

export class MemoryTriggerStore implements TriggerStore {
  readonly #gate = new RecordsGate("the trigger store is closed");
  readonly #monitors = new Map<string, MonitorState>();
  readonly #schedules = gatedScheduleStore(
    Effect.runSync(makeMemoryScheduleStore),
    (call) => this.#gate.run(call)
  );

  clearPendingLaunch(key: string): Promise<void> {
    return this.#gate.run(async () => {
      const state = this.#monitors.get(key);
      if (state !== undefined) {
        this.#monitors.set(key, { observed: state.observed });
      }
    });
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  forgetMonitor(key: string): Promise<void> {
    return this.#gate.run(async () => {
      this.#monitors.delete(key);
    });
  }

  monitorState(key: string): Promise<MonitorState | undefined> {
    return this.#gate.run(() =>
      Promise.resolve(structuredClone(this.#monitors.get(key)))
    );
  }

  saveMonitorState(key: string, state: MonitorState): Promise<void> {
    return this.#gate.run(async () => {
      this.#monitors.set(key, storedMonitorState(key, state));
    });
  }

  schedules(): Promise<ScheduleStoreService> {
    return this.#gate.run(() => Promise.resolve(this.#schedules));
  }
}
