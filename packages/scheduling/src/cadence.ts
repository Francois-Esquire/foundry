import { Cron } from "croner";
import { Effect, Either } from "effect";
import {
  type Cadence,
  type Instant,
  InvalidCadenceError,
  type MisfirePolicy,
  type Weekday,
} from "./domain";

const WEEKDAYS: readonly Weekday[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

const MAX_RECORDED_MISSES = 100;

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, ms: 1, s: 1000 };

const EVERY = /^(\d+)\s*(ms|s|m|h|d)$/;

type CronCadence = Extract<Cadence, { kind: "calendar" | "cron" }>;

const cronOf = (cadence: CronCadence) => {
  if (cadence.kind === "cron") {
    return new Cron(cadence.expression, {
      paused: true,
      timezone: cadence.timezone,
    });
  }
  const days = cadence.weekdays?.length
    ? cadence.weekdays.map((day) => WEEKDAYS.indexOf(day)).join(",")
    : "*";
  return new Cron(`${cadence.minute} ${cadence.hour} * * ${days}`, {
    paused: true,
    timezone: cadence.timezone,
  });
};

const inRange = (value: number, max: number) =>
  Number.isInteger(value) && value >= 0 && value <= max;

const cronProblem = (cadence: CronCadence): string | undefined => {
  try {
    cronOf(cadence).nextRun(new Date(0));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const problemOf = (cadence: Cadence): string | undefined => {
  switch (cadence.kind) {
    case "interval":
      return Number.isSafeInteger(cadence.everyMs) && cadence.everyMs > 0
        ? undefined
        : "everyMs must be a positive integer";
    case "once":
      return Number.isFinite(cadence.at) ? undefined : "at must be finite";
    case "calendar":
      if (!(inRange(cadence.hour, 23) && inRange(cadence.minute, 59))) {
        return "hour must be 0..23 and minute 0..59";
      }
      if (cadence.weekdays?.some((day) => !WEEKDAYS.includes(day))) {
        return "weekdays must be sun..sat";
      }
      return cronProblem(cadence);
    default:
      return cronProblem(cadence);
  }
};

export const validateCadence = (
  cadence: Cadence
): Effect.Effect<Cadence, InvalidCadenceError> => {
  const reason = problemOf(cadence);
  return reason === undefined
    ? Effect.succeed(cadence)
    : Effect.fail(new InvalidCadenceError({ cadence, reason }));
};

export const parseEvery = (
  text: string
): Either.Either<
  Extract<Cadence, { kind: "interval" }>,
  InvalidCadenceError
> => {
  const match = EVERY.exec(text.trim());
  const unit = match?.[2] as keyof typeof UNIT_MS | undefined;
  const everyMs = Number(match?.[1]) * (unit === undefined ? 0 : UNIT_MS[unit]);
  return everyMs > 0
    ? Either.right({ everyMs, kind: "interval" })
    : Either.left(
        new InvalidCadenceError({
          cadence: text,
          reason: "expected a positive duration such as 30s, 5m, 1h, or 1d",
        })
      );
};

export const nextDue = (cadence: Cadence, after: Instant): Instant | null => {
  switch (cadence.kind) {
    case "interval":
      return after + cadence.everyMs;
    case "once":
      return cadence.at > after ? cadence.at : null;
    default:
      return cronOf(cadence).nextRun(new Date(after))?.getTime() ?? null;
  }
};

export const firstDue = (cadence: Cadence, now: Instant): Instant | null =>
  cadence.kind === "once" ? cadence.at : nextDue(cadence, now);

interface DueSlots {
  readonly latest: Instant;
  readonly missed: readonly Instant[];
  readonly next: Instant | null;
}

const dueSlots = (cadence: Cadence, first: Instant, now: Instant): DueSlots => {
  if (cadence.kind === "interval") {
    const elapsed = Math.floor((now - first) / cadence.everyMs);
    const latest = first + elapsed * cadence.everyMs;
    const recorded = Math.min(elapsed, MAX_RECORDED_MISSES);
    return {
      latest,
      missed: Array.from(
        { length: recorded },
        (_, index) => latest - (recorded - index) * cadence.everyMs
      ),
      next: latest + cadence.everyMs,
    };
  }
  const slots = [first];
  let next = nextDue(cadence, first);
  while (next !== null && next <= now) {
    slots.push(next);
    if (slots.length > MAX_RECORDED_MISSES + 1) {
      slots.shift();
    }
    next = nextDue(cadence, next);
  }
  return { latest: slots.at(-1) ?? first, missed: slots.slice(0, -1), next };
};

export interface DueOccurrences {
  readonly nextDueAt: Instant | null;
  readonly skipped: readonly Instant[];
  readonly toFire: Instant | null;
}

export const dueOccurrences = (
  cadence: Cadence,
  nextDueAt: Instant,
  now: Instant,
  misfire: MisfirePolicy
): DueOccurrences => {
  if (now < nextDueAt) {
    return { nextDueAt, skipped: [], toFire: null };
  }
  const { latest, missed, next } = dueSlots(cadence, nextDueAt, now);
  if (missed.length === 0 || misfire === "run-once") {
    return { nextDueAt: next, skipped: missed, toFire: latest };
  }
  return { nextDueAt: next, skipped: [...missed, latest], toFire: null };
};
