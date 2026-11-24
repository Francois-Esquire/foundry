import { Cron } from "croner";
import { Effect, Either } from "effect";
import {
  type Cadence,
  type Instant,
  InvalidCadenceError,
  type MisfirePolicy,
  type OverlapPolicy,
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

const SEARCH_SPAN_MS = 60_000;

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, ms: 1, s: 1000 };

const EVERY = /^(\d+)\s*(ms|s|m|h|d)$/;

const isUnit = (unit: string): unit is keyof typeof UNIT_MS =>
  Object.hasOwn(UNIT_MS, unit);

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

const unknownCadence = (cadence: never): string =>
  `cadence ${JSON.stringify(cadence)} must be an interval, calendar, cron, once, or delay`;

const delayProblem = (
  cadence: Extract<Cadence, { kind: "delay" }>
): string | undefined => {
  if (
    !(Number.isSafeInteger(cadence.afterSettleMs) && cadence.afterSettleMs >= 1)
  ) {
    return "afterSettleMs must be a positive integer";
  }
  return cadence.initialDelayMs === undefined ||
    (Number.isSafeInteger(cadence.initialDelayMs) &&
      cadence.initialDelayMs >= 0)
    ? undefined
    : "initialDelayMs must be an integer of at least 0";
};

const timezoneProblem = (cadence: CronCadence) =>
  cadence.timezone.trim().length === 0
    ? "timezone must name an IANA timezone"
    : undefined;

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
      if (
        cadence.weekdays !== undefined &&
        (cadence.weekdays.length === 0 ||
          cadence.weekdays.some((day) => !WEEKDAYS.includes(day)))
      ) {
        return "weekdays must name at least one of sun..sat";
      }
      return timezoneProblem(cadence) ?? cronProblem(cadence);
    case "cron":
      return timezoneProblem(cadence) ?? cronProblem(cadence);
    case "delay":
      return delayProblem(cadence);
    default:
      return unknownCadence(cadence);
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

const policyProblem = (
  cadence: Cadence,
  overlap: OverlapPolicy,
  misfire: MisfirePolicy
): string | undefined => {
  if (cadence.kind !== "delay") {
    return;
  }
  if (overlap !== "skip") {
    return "a delay cadence only supports the skip overlap policy";
  }
  return misfire === "run-once"
    ? undefined
    : "a delay cadence only supports the run-once misfire policy";
};

export const validatePolicies = (
  cadence: Cadence,
  overlap: OverlapPolicy,
  misfire: MisfirePolicy
): Effect.Effect<void, InvalidCadenceError> => {
  const reason = policyProblem(cadence, overlap, misfire);
  return reason === undefined
    ? Effect.void
    : Effect.fail(new InvalidCadenceError({ cadence, reason }));
};

export const durationMs = (text: string): number | undefined => {
  const match = EVERY.exec(text.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  return amount === undefined || unit === undefined || !isUnit(unit)
    ? undefined
    : Number(amount) * UNIT_MS[unit];
};

export const parseEvery = (
  text: string
): Either.Either<
  Extract<Cadence, { kind: "interval" }>,
  InvalidCadenceError
> => {
  const everyMs = durationMs(text);
  return everyMs !== undefined && Number.isSafeInteger(everyMs) && everyMs > 0
    ? Either.right({ everyMs, kind: "interval" })
    : Either.left(
        new InvalidCadenceError({
          cadence: text,
          reason: "expected a positive duration such as 30s, 5m, 1h, or 1d",
        })
      );
};

const runAfter = (cron: Cron, after: Instant): Instant | null =>
  cron.nextRun(new Date(after))?.getTime() ?? null;

export const nextDue = (cadence: Cadence, after: Instant): Instant | null => {
  switch (cadence.kind) {
    case "interval":
      return after + cadence.everyMs;
    case "once":
      return cadence.at > after ? cadence.at : null;
    case "calendar":
    case "cron":
      return runAfter(cronOf(cadence), after);
    case "delay":
      return after + cadence.afterSettleMs;
    default:
      throw new TypeError(unknownCadence(cadence));
  }
};

export const firstDue = (cadence: Cadence, now: Instant): Instant | null => {
  switch (cadence.kind) {
    case "once":
      return cadence.at;
    case "delay":
      return now + (cadence.initialDelayMs ?? cadence.afterSettleMs);
    default:
      return nextDue(cadence, now);
  }
};

interface DueTimes {
  readonly latest: Instant;
  readonly missed: readonly Instant[];
  readonly next: Instant | null;
}

const runsFrom = (cron: Cron, from: Instant, first: Instant, now: Instant) => {
  const times = from === first ? [first] : [];
  let next = runAfter(cron, from === first ? first : from - 1);
  while (next !== null && next <= now) {
    times.push(next);
    if (times.length > MAX_RECORDED_MISSES + 1) {
      times.shift();
    }
    next = runAfter(cron, next);
  }
  return { next, times };
};

const recentRuns = (cron: Cron, first: Instant, now: Instant) => {
  for (let span = SEARCH_SPAN_MS; ; span *= 2) {
    const from = Math.max(first, now - span);
    const found = runsFrom(cron, from, first, now);
    if (from === first || found.times.length > MAX_RECORDED_MISSES) {
      return found;
    }
  }
};

const dueTimes = (
  cadence: Exclude<Cadence, { kind: "delay" }>,
  first: Instant,
  now: Instant
): DueTimes => {
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
  if (cadence.kind === "once") {
    return { latest: first, missed: [], next: null };
  }
  const { next, times } = recentRuns(cronOf(cadence), first, now);
  return { latest: times.at(-1) ?? first, missed: times.slice(0, -1), next };
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
  if (cadence.kind === "delay") {
    return { nextDueAt: null, skipped: [], toFire: nextDueAt };
  }
  const { latest, missed, next } = dueTimes(cadence, nextDueAt, now);
  if (missed.length === 0 || misfire === "run-once") {
    return { nextDueAt: next, skipped: missed, toFire: latest };
  }
  return { nextDueAt: next, skipped: [...missed, latest], toFire: null };
};
