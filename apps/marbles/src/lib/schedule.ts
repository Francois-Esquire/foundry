import {
  type Cadence,
  durationMs,
  nextDue as nextOccurrence,
} from "@foundry/scheduling";
import type { Engine } from "~/lib/engine";
import type { Launch } from "~/lib/launch";
import { isLaunch } from "~/lib/launch";
import { isRecord } from "~/lib/state/json";
import type { ScheduleHistory, TriggerStore } from "~/lib/trigger-store";
import { finishedAt } from "~/lib/trigger-store";
import type { CalendarSlot, Schedule, Trigger, Weekday } from "~/lib/triggers";

const UNITS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
};
const LET_GO: unique symbol = Symbol("the run was let go");

export function parseEvery(every: string): number {
  const ms = durationMs(every);
  if (ms === undefined) {
    throw new Error(`cannot read cadence "${every}" (want e.g. 30m, 6h, 1d)`);
  }
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(
      `cadence "${every}" must be a positive interval that fits in a safe integer`
    );
  }
  return ms;
}

function cadence(ms: number): string {
  const match = Object.entries(UNITS).find(
    ([, size]) => ms >= size && ms % size === 0
  );
  return match ? `${String(ms / match[1])}${match[0]}` : `${String(ms)}ms`;
}

function inRange(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

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

function weekdays(slot: CalendarSlot): readonly Weekday[] {
  return typeof slot.weekday === "string"
    ? [slot.weekday]
    : (slot.weekday ?? []);
}

function clock(slot: CalendarSlot): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(slot.hour)}:${pad(slot.minute ?? 0)}`;
}

export function describeTrigger(trigger: Trigger): string {
  if (trigger.kind === "interval") {
    return `every ${cadence(trigger.ms)}`;
  }
  const days = weekdays(trigger.slot).join(", ") || "daily";
  return `${days} at ${clock(trigger.slot)}`;
}

const LOCAL_TIME = Intl.DateTimeFormat().resolvedOptions().timeZone;

function cadenceOf(trigger: Trigger): Cadence {
  if (trigger.kind === "interval") {
    return { everyMs: trigger.ms, kind: "interval" };
  }
  const { slot } = trigger;
  const days = weekdays(slot);
  return {
    hour: slot.hour,
    kind: "calendar",
    minute: slot.minute ?? 0,
    timezone: LOCAL_TIME,
    ...(days.length === 0 ? {} : { weekdays: days }),
  };
}

export function nextDue(schedule: Schedule, last: number): number {
  const next = nextOccurrence(cadenceOf(schedule.trigger), last);
  if (next === null) {
    throw new Error(`${describeTrigger(schedule.trigger)} never fires`);
  }
  return next;
}

export type ScheduledEngine = Pick<
  Engine,
  "cancel" | "has" | "launch" | "schedules" | "triggers"
>;

export interface TickOptions {
  readonly canRun?: (schedule: Schedule) => boolean | Promise<boolean>;
  readonly letGo?: AbortSignal;
  readonly now?: () => number;
  readonly print: (line: string) => void;
  readonly scheduled?: boolean;
  readonly signal?: AbortSignal;
  readonly stopped?: AbortSignal;
}

export interface LoopOptions {
  readonly cancel?: AbortSignal;
  readonly letGo?: AbortSignal;
  readonly now?: () => number;
  readonly print: (line: string) => void;
  readonly signal: AbortSignal;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export async function tick(
  engine: ScheduledEngine,
  schedule: Schedule,
  options: TickOptions
): Promise<
  { readonly value: unknown } | { readonly skipped: string } | undefined
> {
  const { triggers } = engine;
  const now = options.now ?? Date.now;
  const claim = await triggers.claimTick(schedule.key);
  if (!claim.claimed) {
    const skipped = `held by ${claim.holder}`;
    options.print(`[schedule] ${schedule.key} skipped: ${skipped}`);
    return { skipped };
  }

  const start = now();
  let status: ScheduleHistory["lastStatus"] | undefined = "failed";
  let dispatched = false;
  try {
    if (
      !(await shouldDispatch(engine, schedule, options, now())) ||
      options.stopped?.aborted
    ) {
      return undefined;
    }
    dispatched = true;
    options.print(`[schedule] ${schedule.key} → ${schedule.workflow}`);
    const detected = await awaitRun(
      engine,
      await engine.launch(schedule.workflow, schedule.input, schedule.key),
      options
    );
    const launch =
      schedule.kind === "monitor" ? pendingOf(detected) : undefined;
    const value =
      launch && !options.stopped?.aborted && detected !== LET_GO
        ? await startPending(engine, schedule.key, launch, options)
        : detected;
    if (value === LET_GO) {
      status = undefined;
      return undefined;
    }
    status = "complete";
    return { value };
  } finally {
    await finishTick(triggers, schedule.key, () =>
      dispatched && status !== undefined
        ? history(schedule, start, now(), status)
        : undefined
    );
  }
}

async function finishTick(
  triggers: TriggerStore,
  key: string,
  record: () => ScheduleHistory | undefined
): Promise<void> {
  try {
    await triggers.finishTick(key, record());
  } catch (error) {
    await triggers.finishTick(key).catch(() => undefined);
    throw error;
  }
}

function history(
  schedule: Schedule,
  start: number,
  finish: number,
  status: ScheduleHistory["lastStatus"]
): ScheduleHistory {
  return {
    kind: schedule.kind,
    label: schedule.label,
    lastFinish: new Date(finish).toISOString(),
    lastStart: new Date(start).toISOString(),
    lastStatus: status,
    nextDue: new Date(nextDue(schedule, finish)).toISOString(),
  };
}

async function shouldDispatch(
  engine: ScheduledEngine,
  schedule: Schedule,
  options: TickOptions,
  now: number
): Promise<boolean> {
  const last = finishedAt(await engine.triggers.lastTick(schedule.key));
  const noLongerDue =
    options.scheduled && last !== undefined && nextDue(schedule, last) > now;
  return !noLongerDue && (await options.canRun?.(schedule)) !== false;
}

function pendingOf(detected: unknown): Launch | undefined {
  return isRecord(detected) && isLaunch(detected.launch)
    ? detected.launch
    : undefined;
}

async function startPending(
  engine: ScheduledEngine,
  key: string,
  launch: Launch,
  options: Pick<TickOptions, "letGo" | "signal">
): Promise<unknown> {
  if (!engine.has(launch.workflow)) {
    await engine.triggers.clearPendingLaunch(key);
    throw new Error(
      `${key}: launch target "${launch.workflow}" is not registered`
    );
  }
  const started = await engine.launch(launch.workflow, launch.input, key);
  await engine.triggers.clearPendingLaunch(key);
  return await awaitRun(engine, started, options);
}

async function awaitRun(
  engine: ScheduledEngine,
  started: { readonly id: string; readonly result: Promise<unknown> },
  { letGo, signal }: Pick<TickOptions, "letGo" | "signal">
): Promise<unknown> {
  const cancel = () => {
    engine.cancel(started.id).catch(() => undefined);
  };
  const released = Promise.withResolvers<typeof LET_GO>();
  const release = () => released.resolve(LET_GO);
  signal?.addEventListener("abort", cancel, { once: true });
  letGo?.addEventListener("abort", release, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  if (letGo?.aborted) {
    release();
  }
  try {
    return await Promise.race([started.result, released.promise]);
  } finally {
    signal?.removeEventListener("abort", cancel);
    letGo?.removeEventListener("abort", release);
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

const POLL_MS = 1000;

export async function runSchedules(
  engine: ScheduledEngine,
  options: LoopOptions
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const { signal } = options;
  const attempted = new Map<string, number>();
  const baseline = async (schedule: Schedule): Promise<number> => {
    const recorded = finishedAt(
      await engine.triggers.lastTick(schedule.key).catch(() => undefined)
    );
    const tried = attempted.get(schedule.key);
    if (tried === undefined) {
      const first = recorded ?? schedule.registeredAt ?? now();
      attempted.set(schedule.key, first);
      return first;
    }
    return recorded === undefined ? tried : Math.max(recorded, tried);
  };

  while (!signal.aborted) {
    const active = await engine.schedules().catch((error: unknown) => {
      options.print(`[schedule] reading schedules failed: ${String(error)}`);
      return [];
    });
    if (signal.aborted) {
      break;
    }
    if (active.length === 0) {
      await sleep(POLL_MS, signal);
      continue;
    }
    const dues: (readonly [Schedule, number])[] = [];
    for (const entry of active) {
      dues.push([entry, nextDue(entry, await baseline(entry))]);
    }
    if (signal.aborted) {
      break;
    }
    const [schedule, due] = dues.reduce((soonest, candidate) =>
      candidate[1] < soonest[1] ? candidate : soonest
    );
    const wait = due - now();
    if (wait > 0) {
      await sleep(Math.min(wait, POLL_MS), signal);
      continue;
    }
    await loopTick(engine, schedule, {
      canRun: async (candidate) =>
        (await engine.schedules()).some((entry) => entry.key === candidate.key),
      ...(options.letGo === undefined ? {} : { letGo: options.letGo }),
      now,
      print: options.print,
      scheduled: true,
      signal: options.cancel ?? signal,
      stopped: signal,
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
