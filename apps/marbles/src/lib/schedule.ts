import { Cron } from "croner";
import type { Engine } from "~/lib/engine";
import type { Launch } from "~/lib/launch";
import { isLaunch } from "~/lib/launch";
import { acknowledgeLaunch } from "~/lib/monitor";
import { isRecord } from "~/lib/state/json";
import { scheduleLockName } from "~/lib/state/locks";
import type { ScheduleHistory } from "~/lib/state/schedules";
import { lastFinish, recordTick } from "~/lib/state/schedules";
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
  const ms = Number(match[1]) * unit;
  // Zero would fire in a hot loop; past a safe integer the sum in nextDue drifts.
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(
      `cadence "${every}" must be a positive interval that fits in a safe integer`
    );
  }
  return ms;
}

/** Milliseconds back to the largest unit that divides them: `30s`, `10m`, `6h`. */
function cadence(ms: number): string {
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
function clock(slot: CalendarSlot): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(slot.hour)}:${pad(slot.minute ?? 0)}`;
}

/** When a trigger fires, for people: `every 30m`, `daily at 09:00`, `mon, fri at 16:30`. */
export function describeTrigger(trigger: Trigger): string {
  if (trigger.kind === "interval") {
    return `every ${cadence(trigger.ms)}`;
  }
  const days = weekdays(trigger.slot).join(", ") || "daily";
  return `${days} at ${clock(trigger.slot)}`;
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

/** What the scheduler needs of an engine: its live triggers, its store, and launching. */
export type ScheduledEngine = Pick<
  Engine,
  "cancel" | "has" | "launch" | "schedules" | "store"
>;

export interface TickOptions {
  /** Recheck a live trigger after taking its execution lock. */
  readonly canRun?: (schedule: Schedule) => boolean;
  readonly now?: () => number;
  readonly print: (line: string) => void;
  /** Loop ticks recheck persisted completion under lock; manual ticks are forced. */
  readonly scheduled?: boolean;
  /** Cancels the run a tick started. */
  readonly signal?: AbortSignal;
}

export interface LoopOptions {
  readonly now?: () => number;
  readonly print: (line: string) => void;
  readonly signal: AbortSignal;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * One firing of a schedule: take its lock, run, record the tick in the
 * engine's store. Shared by `roll <schedule>` and the loop. Resolves
 * `undefined` when another holder has the lock; rejects as the run does,
 * after the history is written.
 */
export async function tick(
  engine: ScheduledEngine,
  schedule: Schedule,
  options: TickOptions
): Promise<{ readonly value: unknown } | undefined> {
  const { store } = engine;
  const now = options.now ?? Date.now;
  const lock = store.lock(scheduleLockName(schedule.key));
  if ("holder" in lock) {
    options.print(`[schedule] ${schedule.key} skipped: held by ${lock.holder}`);
    return undefined;
  }

  const start = now();
  let status: ScheduleHistory["lastStatus"] = "failed";
  let dispatched = false;
  try {
    if (!shouldDispatch(engine, schedule, options, now())) {
      return undefined;
    }
    dispatched = true;
    options.print(`[schedule] ${schedule.key} → ${schedule.workflow}`);
    const detected = await awaitRun(
      engine,
      await engine.launch(schedule.workflow, schedule.input, schedule.key),
      options.signal
    );
    const launch =
      schedule.kind === "monitor" ? pendingOf(detected) : undefined;
    const value = launch
      ? await startPending(engine, schedule.key, launch, options.signal)
      : detected;
    status = "complete";
    return { value };
  } finally {
    try {
      const finish = now();
      if (dispatched) {
        recordTick(store, schedule.key, {
          kind: schedule.kind,
          label: schedule.label,
          lastFinish: new Date(finish).toISOString(),
          lastStart: new Date(start).toISOString(),
          lastStatus: status,
          nextDue: new Date(nextDue(schedule, finish)).toISOString(),
        });
      }
    } finally {
      lock.release();
    }
  }
}

function shouldDispatch(
  engine: ScheduledEngine,
  schedule: Schedule,
  options: TickOptions,
  now: number
): boolean {
  const last = lastFinish(engine.store, schedule.key);
  const noLongerDue =
    options.scheduled && last !== undefined && nextDue(schedule, last) > now;
  return !noLongerDue && options.canRun?.(schedule) !== false;
}

/** What a monitor's detector asked to start, if anything. */
function pendingOf(detected: unknown): Launch | undefined {
  return isRecord(detected) && isLaunch(detected.launch)
    ? detected.launch
    : undefined;
}

/**
 * A monitor's handler may hand back something to start; it runs as its own
 * run, attributed to the monitor. The monitor holds the launch as pending
 * until it has been started, so a tick that dies in between hands it out
 * again; once started, it is the run's own to finish. A target that no
 * longer exists can never start: that launch is acknowledged and fails this
 * tick, not every tick after it. Any other failure to start (a setup that
 * threw) leaves the launch pending, so the next tick tries again.
 */
async function startPending(
  engine: ScheduledEngine,
  key: string,
  launch: Launch,
  signal: AbortSignal | undefined
): Promise<unknown> {
  if (!engine.has(launch.workflow)) {
    acknowledgeLaunch(engine.store, key);
    throw new Error(
      `${key}: launch target "${launch.workflow}" is not registered`
    );
  }
  const started = await engine.launch(launch.workflow, launch.input, key);
  acknowledgeLaunch(engine.store, key);
  return await awaitRun(engine, started, signal);
}

/** A run's value; aborting `signal` cancels the run. */
async function awaitRun(
  engine: ScheduledEngine,
  started: { readonly id: string; readonly result: Promise<unknown> },
  signal: AbortSignal | undefined
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

/** How long the loop sleeps before looking at the live triggers again. */
const POLL_MS = 1000;

/**
 * The engine's live triggers, until `signal` aborts: sleep to the soonest
 * due (at most a second, so triggers added meanwhile are seen), fire it,
 * recompute. A trigger is due a cadence after its last recorded finish in
 * the engine's store, so a restart keeps the cadence; one never recorded
 * counts from when it was registered, else from when the loop first saw it.
 */
export async function runSchedules(
  engine: ScheduledEngine,
  options: LoopOptions
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const { signal } = options;
  // When the loop first saw each trigger, then when it last tried one: a
  // tick that recorded nothing (its lock was held, it was no longer live)
  // waits a cadence from the attempt rather than firing again at once.
  const attempted = new Map<string, number>();
  const baseline = (schedule: Schedule): number => {
    const recorded = lastFinish(engine.store, schedule.key);
    const tried = attempted.get(schedule.key);
    if (tried === undefined) {
      const first = recorded ?? schedule.registeredAt ?? now();
      attempted.set(schedule.key, first);
      return first;
    }
    return recorded === undefined ? tried : Math.max(recorded, tried);
  };

  while (!signal.aborted) {
    const active = engine.schedules();
    if (active.length === 0) {
      await sleep(POLL_MS, signal);
      continue;
    }
    const [schedule, due] = active
      .map((entry) => [entry, nextDue(entry, baseline(entry))] as const)
      .reduce((soonest, candidate) =>
        candidate[1] < soonest[1] ? candidate : soonest
      );
    const wait = due - now();
    if (wait > 0) {
      await sleep(Math.min(wait, POLL_MS), signal);
      continue;
    }
    await loopTick(engine, schedule, {
      canRun: (candidate) =>
        engine.schedules().some((entry) => entry.key === candidate.key),
      now,
      print: options.print,
      scheduled: true,
      signal,
    });
    attempted.set(schedule.key, now());
  }
}

async function loopTick(
  engine: ScheduledEngine,
  schedule: Schedule,
  options: TickOptions
): Promise<void> {
  try {
    await tick(engine, schedule, options);
  } catch (error) {
    options.print(`[schedule] ${schedule.key} failed: ${String(error)}`);
  }
}
