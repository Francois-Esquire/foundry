import { isRecord } from "~/lib/state/json";
import type { StateStore } from "~/lib/state/store";

/** A schedule's document in the `schedules` collection: the last tick and when the next is due. */
export interface ScheduleHistory {
  /** Recorded so `status`, which never loads the config, can label a monitor. */
  readonly kind?: "schedule" | "monitor";
  /** The trigger's label, for `status`; older files have none. */
  readonly label?: string;
  readonly lastFinish: string;
  readonly lastStart: string;
  readonly lastStatus: "complete" | "failed";
  readonly nextDue: string;
}

export function recordTick(
  store: StateStore,
  key: string,
  history: ScheduleHistory
): void {
  store.write("schedules", key, { version: 1, ...history });
}

/** When the schedule's last recorded tick finished; the rest is for humans and `status`. */
export function lastFinish(store: StateStore, key: string): number | undefined {
  const recorded = store.read("schedules", key);
  const finished =
    isRecord(recorded) && typeof recorded.lastFinish === "string"
      ? Date.parse(recorded.lastFinish)
      : Number.NaN;
  return Number.isNaN(finished) ? undefined : finished;
}
