import { Cron } from "croner";
import type { Engine } from "~/lib/engine";
import { isLaunch } from "~/lib/launch";
import { acknowledgeLaunch } from "~/lib/monitor";
import { isRecord } from "~/lib/state/json";
import { acquireLock } from "~/lib/state/locks";
import type { ScheduleHistory } from "~/lib/state/schedules";
import { readLastFinish, writeScheduleHistory } from "~/lib/state/schedules";
import type { CalendarSlot, Schedule, Trigger, Weekday } from "~/lib/triggers";

const UNITS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
};
const EVERY_PATTERN = /^(\d+)([smhd])$/;

/** `"30m" | "6h" | "1d"` to milliseconds. */
export function parseEvery(every: string): number {
  const match = EVERY_PATTERN.exec(every.trim());
  const unit = match?.[2] === undefined ? undefined : UNITS[match[2]];
  if (!match || unit === undefined) {
    throw new Error(`cannot read cadence "${every}" (want e.g. 30m, 6h, 1d)`);
  }
  return Number(match[1]) * unit;
}

/** Milliseconds back to the largest unit that divides them: `30s`, `10m`, `6h`. */
export function cadence(ms: number): string {
  // Largest unit first, so six hours reads `6h`, not `21600s`.
  const match = Object.entries(UNITS).find(
    ([, size]) => ms >= size && ms % size === 0
  );
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
      `cannot read calendar slot ${JSON.stringify(at)} (want hour 0–23, minute 0–59)`
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
    throw new Error(`"${pattern}" never fires`);
  }
  return next.getTime();
}

export interface TickOptions {
  /** Recheck a live trigger after taking its execution lock. */
  readonly canRun?: (schedule: Schedule) => boolean;
  readonly now?: () => number;
  readonly print: (line: string) => void;
  /** Loop ticks recheck persisted completion under lock; manual ticks are forced. */
  readonly scheduled?: boolean;
  readonly signal?: AbortSignal;
  /** Workspace state dir for the lock and history; omit to write nothing. */
  readonly state?: string;
}

export interface LoopOptions extends TickOptions {
  /** Live catalogue. When supplied, empty catalogues wait for new triggers. */
  readonly getSchedules?: () => readonly Schedule[];
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
      : acquireLock(options.state, schedule.key);
  if (typeof lock === "number") {
    options.print(
      `[schedule] ${schedule.key} skipped: running as pid ${String(lock)}`
    );
    return undefined;
  }

  const start = now();
  let status: ScheduleHistory["lastStatus"] = "failed";
  let dispatched = false;
  try {
    if (!shouldDispatch(schedule, options, now())) {
      return undefined;
    }
    dispatched = true;
    options.print(`[schedule] ${schedule.key} → ${schedule.workflow}`);
    const detected =
      options.signal && typeof engine.launch === "function"
        ? await awaitScheduledRun(
            engine,
            await engine.launch(
              schedule.workflow,
              schedule.input,
              schedule.key
            ),
            options.signal
          )
        : await engine.run(schedule.workflow, schedule.input, schedule.key);
    // A monitor's handler may hand back something to start; it runs as its
    // own run, attributed to the monitor. The monitor holds the launch as
    // pending until it has been started, so a tick that dies in between
    // hands it out again; once started, it is the run's own to finish.
    const launch =
      schedule.kind === "monitor" &&
      isRecord(detected) &&
      isLaunch(detected.launch)
        ? detected.launch
        : undefined;
    let value: unknown = detected;
    if (launch) {
      // A target that no longer exists can never start: that launch is
      // acknowledged and fails this tick, not every tick after it. Any other
      // failure to start (a setup that threw) leaves the launch pending, so
      // the next tick tries again.
      if (!engine.catalog.definitions.has(launch.workflow)) {
        acknowledgeLaunch(schedule.key);
        throw new Error(
          `${schedule.key}: launch target "${launch.workflow}" is not registered`
        );
      }
      const started = await engine.launch(
        launch.workflow,
        launch.input,
        schedule.key
      );
      acknowledgeLaunch(schedule.key);
      value = await awaitScheduledRun(engine, started, options.signal);
    }
    status = "complete";
    return { value };
  } finally {
    try {
      const finish = now();
      if (dispatched && options.state !== undefined) {
        writeScheduleHistory(options.state, schedule.key, {
          kind: schedule.kind,
          label: schedule.label,
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

function shouldDispatch(
  schedule: Schedule,
  options: TickOptions,
  now: number
): boolean {
  const last =
    options.state === undefined
      ? undefined
      : readLastFinish(options.state, schedule.key);
  const noLongerDue =
    options.scheduled && last !== undefined && nextDue(schedule, last) > now;
  return !noLongerDue && options.canRun?.(schedule) !== false;
}

async function awaitScheduledRun(
  engine: Engine,
  started: { readonly id: string; readonly result: Promise<unknown> },
  signal?: AbortSignal
): Promise<unknown> {
  const cancel = () => {
    engine.cancel(started.id).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  try {
    return await started.result;
  } finally {
    signal?.removeEventListener("abort", cancel);
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
function soonestSchedule(
  schedules: readonly Schedule[],
  last: Map<string, number>,
  now: () => number,
  state?: string
): readonly [Schedule, number] {
  return schedules
    .map((entry) => {
      let finish = last.get(entry.key);
      if (finish === undefined) {
        finish =
          (state === undefined
            ? undefined
            : readLastFinish(state, entry.key)) ??
          entry.registeredAt ??
          now();
        last.set(entry.key, finish);
      }
      return [entry, nextDue(entry, finish)] as const;
    })
    .reduce((soonest, candidate) =>
      candidate[1] < soonest[1] ? candidate : soonest
    );
}

export async function runSchedules(
  engine: Engine,
  schedules: readonly Schedule[],
  options: LoopOptions
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const { state } = options;
  const last = new Map<string, number>();
  const aborted = () => options.signal.aborted;

  while (!aborted()) {
    const active = options.getSchedules?.() ?? schedules;
    if (active.length === 0) {
      if (!options.getSchedules) {
        return;
      }
      await sleep(1000, options.signal);
      continue;
    }
    const [schedule, due] = soonestSchedule(active, last, now, state);
    const wait = due - now();
    if (wait > 0) {
      await sleep(
        options.getSchedules ? Math.min(wait, 1000) : wait,
        options.signal
      );
      if (options.getSchedules) {
        continue;
      }
    }
    if (aborted()) {
      return;
    }

    await loopTick(engine, schedule, {
      canRun: (candidate) => currentSchedule(candidate, schedules, options),
      now,
      print: options.print,
      scheduled: true,
      signal: options.signal,
      state,
    });
    last.set(schedule.key, now());
  }
}

function currentSchedule(
  candidate: Schedule,
  schedules: readonly Schedule[],
  options: LoopOptions
): boolean {
  return (options.getSchedules?.() ?? schedules).some(
    (entry) => entry.key === candidate.key
  );
}

async function loopTick(
  engine: Engine,
  schedule: Schedule,
  options: TickOptions
): Promise<void> {
  try {
    await tick(engine, schedule, options);
  } catch (error) {
    options.print(`[schedule] ${schedule.key} failed: ${String(error)}`);
  }
}
