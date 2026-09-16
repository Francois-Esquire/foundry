import { Cron } from "croner";

import type { Engine } from "~/engine";
import type { CalendarSlot, Schedule, Trigger, Weekday } from "~/lib/registry";
import { acquireLock } from "~/state/locks";
import type { ScheduleHistory } from "~/state/schedules";
import { readLastFinish, writeScheduleHistory } from "~/state/schedules";

const UNITS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
};

/** `"30m" | "6h" | "1d"` to milliseconds. */
export function parseEvery(every: string): number {
  const match = /^(\d+)([smhd])$/.exec(every.trim());
  const unit = match?.[2] === undefined ? undefined : UNITS[match[2]];
  if (!match || unit === undefined) {
    throw new Error(
      `quirks: cannot read cadence "${every}" (want e.g. 30m, 6h, 1d)`
    );
  }
  return Number(match[1]) * unit;
}

/** Milliseconds back to the largest unit that divides them: `30s`, `10m`, `6h`. */
export function cadence(ms: number): string {
  const match = Object.entries(UNITS)
    .reverse()
    .find(([, size]) => ms >= size && ms % size === 0);
  return match ? `${String(ms / match[1])}${match[0]}` : `${String(ms)}ms`;
}

function inRange(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

/** The `at` option to a trigger; throws at registration so a bad slot never reaches the loop. */
export function parseAt(at: string | CalendarSlot): Trigger {
  if (typeof at === "string") {
    return { kind: "interval", ms: parseEvery(at) };
  }
  const minute = at.minute ?? 0;
  if (!(inRange(at.hour, 23) && inRange(minute, 59))) {
    throw new Error(
      `quirks: cannot read calendar slot ${JSON.stringify(at)} (want hour 0–23, minute 0–59)`
    );
  }
  return { kind: "calendar", slot: { ...at, minute } };
}

export function weekdays(slot: CalendarSlot): readonly Weekday[] {
  return typeof slot.weekday === "string"
    ? [slot.weekday]
    : (slot.weekday ?? []);
}

/** `09:05`. */
export function clock(slot: CalendarSlot): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(slot.hour)}:${pad(slot.minute ?? 0)}`;
}

/**
 * When a schedule fires next, given when it last finished (or when the loop
 * started). Measuring from completion rather than start is what makes a tick
 * that came due mid-run skip rather than queue.
 */
export function nextDue(schedule: Schedule, last: number): number {
  const { trigger } = schedule;
  if (trigger.kind === "interval") {
    return last + trigger.ms;
  }
  const { slot } = trigger;
  const days = weekdays(slot);
  const pattern = `${String(slot.minute ?? 0)} ${String(slot.hour)} * * ${
    days.length === 0 ? "*" : days.map((day) => day.toUpperCase()).join(",")
  }`;
  const next = new Cron(pattern).nextRun(new Date(last));
  if (next === null) {
    throw new Error(`quirks: "${pattern}" never fires`);
  }
  return next.getTime();
}

export interface TickOptions {
  readonly now?: () => number;
  readonly print: (line: string) => void;
  /** Workspace state dir for the lock and history; omit to write nothing. */
  readonly state?: string;
}

export interface LoopOptions extends TickOptions {
  readonly signal: AbortSignal;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * One firing of a schedule: take its lock, run, record the tick. Shared by
 * `once <schedule>` and the loop. Resolves `undefined` when another process
 * holds the lock; rejects as the run does, after the history is written.
 */
export async function tick(
  engine: Engine,
  schedule: Schedule,
  options: TickOptions
): Promise<{ readonly value: unknown } | undefined> {
  const now = options.now ?? Date.now;
  const lock =
    options.state === undefined
      ? undefined
      : acquireLock(options.state, schedule.name);
  if (typeof lock === "number") {
    options.print(
      `[schedule] ${schedule.name} skipped: running as pid ${String(lock)}`
    );
    return undefined;
  }

  options.print(`[schedule] ${schedule.name} → ${schedule.workflow}`);
  const start = now();
  let status: ScheduleHistory["lastStatus"] = "failed";
  try {
    const value = await engine.run(schedule.workflow, schedule.input);
    status = "complete";
    return { value };
  } finally {
    try {
      const finish = now();
      if (options.state !== undefined) {
        writeScheduleHistory(options.state, schedule.name, {
          kind: schedule.kind,
          lastFinish: new Date(finish).toISOString(),
          lastStart: new Date(start).toISOString(),
          lastStatus: status,
          nextDue: new Date(nextDue(schedule, finish)).toISOString(),
        });
      }
    } finally {
      lock?.release();
    }
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * `setTimeout` to the next due schedule, run it, recompute. State is the
 * completion time per schedule, seeded from the last recorded tick when
 * there is one so a restart keeps the cadence.
 */
export async function runSchedules(
  engine: Engine,
  schedules: readonly Schedule[],
  options: LoopOptions
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const { state } = options;
  const last = new Map(
    schedules.map((schedule) => [
      schedule,
      (state === undefined
        ? undefined
        : readLastFinish(state, schedule.name)) ?? now(),
    ])
  );
  const aborted = () => options.signal.aborted;

  while (!aborted() && schedules.length > 0) {
    const [schedule, due] = [...last.entries()]
      .map(([entry, finished]) => [entry, nextDue(entry, finished)] as const)
      .reduce((soonest, candidate) =>
        candidate[1] < soonest[1] ? candidate : soonest
      );
    const wait = due - now();
    if (wait > 0) {
      await sleep(wait, options.signal);
    }
    if (aborted()) {
      return;
    }

    try {
      await tick(engine, schedule, { now, print: options.print, state });
    } catch (error) {
      options.print(`[schedule] ${schedule.name} failed: ${String(error)}`);
    }
    last.set(schedule, now());
  }
}
