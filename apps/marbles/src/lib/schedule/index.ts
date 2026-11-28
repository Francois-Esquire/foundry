import { canonicalizeJson } from "@foundry/lib/json";
import type {
  Cadence,
  DispatchTarget,
  JobOutcome,
  RegisterScheduleInput,
  Schedule as StoredSchedule,
} from "@foundry/scheduling";
import { nextDue as nextOccurrence } from "@foundry/scheduling";
import { z } from "zod";
import type { Engine } from "~/lib/engine";
import type { ExecutionStatus } from "~/lib/executions/statuses";
import type { Launched } from "~/lib/runs";
import type { Launch } from "~/lib/runs/launch";
import { isLaunch } from "~/lib/runs/launch";
import type {
  CalendarSlot,
  Schedule,
  Trigger,
  Weekday,
} from "~/lib/schedule/triggers";
import { isRecord, jsonData } from "~/lib/shared/json-data";

const UNITS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1000,
};

function spelled(ms: number): string {
  const match = Object.entries(UNITS).find(
    ([, size]) => ms >= size && ms % size === 0
  );
  return match ? `${String(ms / match[1])}${match[0]}` : `${String(ms)}ms`;
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
    return `every ${spelled(trigger.ms)}`;
  }
  const days = weekdays(trigger.slot).join(", ") || "daily";
  return `${days} at ${clock(trigger.slot)}`;
}

const LOCAL_TIME = Intl.DateTimeFormat().resolvedOptions().timeZone;

function intervalAsDelayAfterSettle(
  everyMs: number,
  initialDelayMs?: number
): Cadence {
  return {
    afterSettleMs: everyMs,
    kind: "delay",
    ...(initialDelayMs === undefined ? {} : { initialDelayMs }),
  };
}

function cadenceOf(trigger: Trigger, initialDelayMs?: number): Cadence {
  if (trigger.kind === "interval") {
    return intervalAsDelayAfterSettle(trigger.ms, initialDelayMs);
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

const scheduledTargetSchema = z.object({
  input: z.unknown(),
  kind: z.enum(["schedule", "monitor"]),
  label: z.string(),
});

export type ScheduledTarget = z.infer<typeof scheduledTargetSchema>;

export function scheduledTarget(
  target: DispatchTarget
): ScheduledTarget | undefined {
  const read = scheduledTargetSchema.safeParse(target.input);
  return read.success ? read.data : undefined;
}

function dispatchTarget(schedule: Schedule): DispatchTarget {
  return {
    handler: { name: schedule.workflow },
    input: {
      input: jsonData(schedule.input),
      kind: schedule.kind,
      label: schedule.label,
    },
  };
}

function sameJson(one: unknown, other: unknown): boolean {
  return canonicalizeJson(one) === canonicalizeJson(other);
}

function withoutInitialDelay(cadence: Cadence): Cadence {
  if (cadence.kind !== "delay") {
    return cadence;
  }
  const { initialDelayMs: _initial, ...rhythm } = cadence;
  return rhythm;
}

function firstDelay(schedule: Schedule, now: number): number | undefined {
  const { registeredAt, trigger } = schedule;
  return trigger.kind === "interval" && registeredAt !== undefined
    ? Math.max(0, registeredAt + trigger.ms - now)
    : undefined;
}

export function registration(
  schedule: Schedule,
  stored: StoredSchedule | undefined,
  now: number
): RegisterScheduleInput | undefined {
  const rhythm = cadenceOf(schedule.trigger);
  const cadence =
    stored !== undefined &&
    sameJson(withoutInitialDelay(stored.cadence), rhythm)
      ? stored.cadence
      : cadenceOf(schedule.trigger, firstDelay(schedule, now));
  const target = dispatchTarget(schedule);
  if (
    stored !== undefined &&
    sameJson(stored.cadence, cadence) &&
    sameJson(stored.target, target)
  ) {
    return;
  }
  return {
    cadence,
    id: schedule.key,
    misfire: "run-once",
    overlap: "skip",
    target,
  };
}

export function outcomeOf(status: ExecutionStatus): JobOutcome | undefined {
  switch (status) {
    case "complete":
      return "complete";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return;
  }
}

export type ScheduledEngine = Pick<
  Engine,
  | "automations"
  | "cancel"
  | "executions"
  | "has"
  | "launch"
  | "schedules"
  | "triggers"
>;

export async function startScheduled(
  engine: ScheduledEngine,
  schedule: Schedule,
  idempotencyKey?: string
): Promise<Launched<unknown>> {
  if (schedule.kind === "schedule") {
    await engine.triggers.forgetMonitor(schedule.key);
  }
  return await engine.launch(schedule.workflow, schedule.input, {
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    triggerId: schedule.key,
  });
}

export function pendingOf(
  schedule: Schedule,
  detected: unknown
): Launch | undefined {
  return schedule.kind === "monitor" &&
    isRecord(detected) &&
    isLaunch(detected.launch)
    ? detected.launch
    : undefined;
}

export async function startPending(
  engine: ScheduledEngine,
  key: string,
  launch: Launch
): Promise<Launched<unknown>> {
  if (!engine.has(launch.workflow)) {
    await engine.triggers.clearPendingLaunch(key);
    throw new Error(
      `${key}: launch target "${launch.workflow}" is not registered`
    );
  }
  const started = await engine.launch(launch.workflow, launch.input, key);
  await engine.triggers.clearPendingLaunch(key);
  return started;
}

export async function rollSchedule(
  engine: ScheduledEngine,
  schedule: Schedule,
  { print }: { readonly print: (line: string) => void }
): Promise<{ readonly value: unknown }> {
  print(`[schedule] ${schedule.key} → ${schedule.workflow}`);
  const detected = await (await startScheduled(engine, schedule)).result;
  const launch = pendingOf(schedule, detected);
  if (launch === undefined) {
    return { value: detected };
  }
  const started = await startPending(engine, schedule.key, launch);
  return { value: await started.result };
}
