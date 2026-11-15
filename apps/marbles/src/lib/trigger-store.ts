import { z } from "zod";

import { RecordsGate } from "~/lib/events/records";
import type { Launch } from "~/lib/launch";

/**
 * What a workspace's triggers keep between ticks, each by its key, which a
 * schedule or monitor keeps for as long as it is declared, so an engine
 * that declares the same trigger later carries on from it:
 *
 * - a schedule's last tick (`ScheduleHistory`), read by `status`, the
 *   dashboard and the schedule loop;
 * - a monitor's state (`MonitorState`): what it last saw, and a launch it
 *   handed out that no tick has started yet;
 * - the claim on a trigger's tick, so a tick that lands while the
 *   previous one is still going is skipped rather than doubled up, by any
 *   engine sharing the store.
 *
 * The store enforces nothing about them: the schedule loop (`schedule.ts`)
 * and the detector (`monitor.ts`) say when each is written.
 * `MemoryTriggerStore` keeps them in this process, shared by every engine
 * handed it; the Marbles database keeps them on disk
 * (`database/triggers.ts`).
 */
export interface TriggerStore {
  /**
   * Take the key's tick: `claimed` when this caller has it now, else who
   * holds it (`pid 1234`, `this process`). A holder whose process has
   * exited holds nothing.
   */
  claimTick(key: string): Promise<TickClaim>;
  /** Refuse every call from now on, once those under way have settled. */
  close(): Promise<void>;
  /**
   * Give up the key's tick, recording how it went when it ran, in one
   * write; a claim someone else holds now is left alone.
   */
  finishTick(key: string, tick?: ScheduleHistory): Promise<void>;
  /** The key's last recorded tick; `undefined` before its first. */
  lastTick(key: string): Promise<ScheduleHistory | undefined>;
  /** What the monitor `key` keeps; `undefined` before its first change. */
  monitorState(key: string): Promise<MonitorState | undefined>;
  /** Keep `state` as the monitor `key`'s, whole. */
  saveMonitorState(key: string, state: MonitorState): Promise<void>;
}

export type TickClaim =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly holder: string };

/** How a schedule's last tick went, for `status`, the dashboard and the loop. */
export const scheduleHistorySchema = z.object({
  /** Recorded so `status`, which never loads the config, can label a monitor. */
  kind: z.enum(["schedule", "monitor"]).optional(),
  /** The trigger's label, for `status`. */
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

/**
 * What a monitor keeps: what it last saw of its source (`observed`, its
 * own shape per kind of source), and a launch it handed out that no tick
 * has started yet, which the next tick starts before polling again.
 */
export const monitorStateSchema = z.object({
  observed: z.record(z.string(), z.unknown()),
  pending: launchSchema.optional(),
});

export interface MonitorState {
  readonly observed: Readonly<Record<string, unknown>>;
  readonly pending?: Launch;
}

/** When a tick last finished, in ms since the epoch; `undefined` before its first. */
export function finishedAt(
  tick: ScheduleHistory | undefined
): number | undefined {
  return tick === undefined ? undefined : Date.parse(tick.lastFinish);
}

/**
 * The trigger store held in this process. One store may be shared by
 * several engines, as one database is: a tick one of them claimed is held
 * for all of them. Records are copied in and out, so no caller shares a
 * reference with the store.
 */
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

  close(): Promise<void> {
    return this.#gate.close();
  }

  finishTick(key: string, tick?: ScheduleHistory): Promise<void> {
    return this.#gate.run(async () => {
      if (tick !== undefined) {
        this.#ticks.set(key, scheduleHistorySchema.parse(tick));
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
    return this.#gate.run(() =>
      Promise.resolve(structuredClone(this.#monitors.get(key)))
    );
  }

  saveMonitorState(key: string, state: MonitorState): Promise<void> {
    return this.#gate.run(async () => {
      this.#monitors.set(
        key,
        monitorStateSchema.parse(structuredClone(state)) as MonitorState
      );
    });
  }
}
