import { z } from "zod";

import { RecordsGate } from "~/lib/events/records";
import type { Launch } from "~/lib/launch";
import { storableJson } from "~/lib/state/json";

export interface TriggerStore {
  claimTick(key: string): Promise<TickClaim>;
  clearPendingLaunch(key: string): Promise<void>;
  close(): Promise<void>;
  finishTick(key: string, tick?: ScheduleHistory): Promise<void>;
  lastTick(key: string): Promise<ScheduleHistory | undefined>;
  monitorState(key: string): Promise<MonitorState | undefined>;
  saveMonitorState(key: string, state: MonitorState): Promise<void>;
}

export type TickClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly holder: string };

export const scheduleHistorySchema = z.object({
  kind: z.enum(["schedule", "monitor"]).optional(),
  label: z.string().optional(),
  lastFinish: z.iso.datetime(),
  lastStart: z.iso.datetime(),
  lastStatus: z.enum(["complete", "failed"]),
  nextDue: z.iso.datetime(),
});

export type ScheduleHistory = z.infer<typeof scheduleHistorySchema>;

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

export function finishedAt(
  tick: ScheduleHistory | undefined
): number | undefined {
  return tick === undefined ? undefined : Date.parse(tick.lastFinish);
}

export class MemoryTriggerStore implements TriggerStore {
  readonly #gate = new RecordsGate("the trigger store is closed");
  readonly #claimed = new Set<string>();
  readonly #ticks = new Map<string, ScheduleHistory>();
  readonly #monitors = new Map<string, MonitorState>();

  claimTick(key: string): Promise<TickClaim> {
    return this.#gate.run<TickClaim>(() => {
      if (this.#claimed.has(key)) {
        return Promise.resolve({ claimed: false, holder: "this process" });
      }
      this.#claimed.add(key);
      return Promise.resolve({ claimed: true });
    });
  }

  clearPendingLaunch(key: string): Promise<void> {
    return this.#gate.run(async () => {
      const state = this.#monitors.get(key);
      if (state !== undefined) {
        this.#monitors.set(key, { observed: state.observed });
      }
    });
  }

  async close(): Promise<void> {
    await this.#gate.close();
    this.#claimed.clear();
  }

  finishTick(key: string, tick?: ScheduleHistory): Promise<void> {
    return this.#gate.run(async () => {
      if (tick !== undefined) {
        this.#ticks.set(key, scheduleHistorySchema.parse(tick));
        if (tick.kind === "schedule") {
          this.#monitors.delete(key);
        }
      }
      this.#claimed.delete(key);
    });
  }

  lastTick(key: string): Promise<ScheduleHistory | undefined> {
    return this.#gate.run(() =>
      Promise.resolve(structuredClone(this.#ticks.get(key)))
    );
  }

  monitorState(key: string): Promise<MonitorState | undefined> {
    return this.#gate.run(() => {
      if (this.#ticks.get(key)?.kind === "schedule") {
        this.#monitors.delete(key);
      }
      return Promise.resolve(structuredClone(this.#monitors.get(key)));
    });
  }

  saveMonitorState(key: string, state: MonitorState): Promise<void> {
    return this.#gate.run(async () => {
      this.#monitors.set(key, storedMonitorState(key, state));
      const tick = this.#ticks.get(key);
      if (tick?.kind === "schedule") {
        this.#ticks.delete(key);
      } else if (tick !== undefined) {
        this.#ticks.set(key, { ...tick, kind: "monitor" });
      }
    });
  }
}
