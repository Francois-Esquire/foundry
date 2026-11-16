import { z } from "zod";

import { RecordsGate } from "~/lib/events/records";
import type { Launch } from "~/lib/launch";
import { storableJson } from "~/lib/state/json";

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
  /**
   * Clear the monitor `key`'s pending launch, in one write, once a tick
   * has started it or given up on it; what it last saw stays.
   */
  clearPendingLaunch(key: string): Promise<void>;
  /**
   * Refuse every call from now on, once those under way have settled, and
   * give up every tick this store has claimed.
   */
  close(): Promise<void>;
  /**
   * Give up the key's tick, recording how it went when it ran, in one
   * write; a claim someone else holds now is left alone. A tick recorded
   * for a schedule drops, in the same write, whatever a monitor under the
   * key left (what it saw, a launch it handed over): the key is no longer
   * a monitor's, and a monitor declared there again starts from nothing.
   */
  finishTick(key: string, tick?: ScheduleHistory): Promise<void>;
  /** The key's last recorded tick; `undefined` before its first. */
  lastTick(key: string): Promise<ScheduleHistory | undefined>;
  /**
   * What the monitor `key` keeps; `undefined` before its first change. A
   * key whose last recorded tick names a schedule keeps none: what a
   * monitor left there (an older Marbles' leftover) is dropped here, in the
   * same write that finds it, and no launch it holds is handed out.
   */
  monitorState(key: string): Promise<MonitorState | undefined>;
  /**
   * Keep `state` as the monitor `key`'s, whole, and record the key as a
   * monitor's in the same write, so what it keeps before its tick is
   * recorded is handed back to it. Rejects, keeping nothing, a state that
   * would not read back as it is (`storedMonitorState`).
   */
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

/**
 * The copy of a monitor's `state` every store keeps: what it saw and its
 * pending launch's input as plain JSON, refused with a `NotStorableError`
 * naming the part JSON would not give back as it is (`storableJson`), so
 * a state reads back the same from memory as from the database.
 */
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

/** When a tick last finished, in ms since the epoch; `undefined` before its first. */
export function finishedAt(
  tick: ScheduleHistory | undefined
): number | undefined {
  return tick === undefined ? undefined : Date.parse(tick.lastFinish);
}

/**
 * The trigger store held in this process, for one engine, as
 * `MemoryRunStore` is: nothing outlives the process. A tick claimed
 * through it is held for every caller of it. Records are copied in and
 * out, so no caller shares a reference with the store.
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
      // Nothing a monitor left under a key a schedule ticked last is handed out.
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
      if (tick !== undefined) {
        this.#ticks.set(key, { ...tick, kind: "monitor" });
      }
    });
  }
}
