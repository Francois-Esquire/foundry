import { Schedule } from "effect";

import type { BackoffStrategy, Duration, RetryPolicy } from "./types";

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

export function parseDuration(d: Duration): number {
  if (typeof d === "number") {
    return d;
  }
  const match = DURATION_PATTERN.exec(d.trim());
  if (!match) {
    throw new Error(`Unparseable duration: ${d}`);
  }
  const n = Number(match[1]);
  switch (match[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      throw new Error(`Unparseable duration: ${d}`);
  }
}

export function toSchedule(policy: RetryPolicy): Schedule.Schedule<unknown> {
  const max = policy.maxAttempts ?? 1;
  let schedule: Schedule.Schedule<unknown> = backoffSchedule(policy.backoff);
  schedule = Schedule.intersect(
    schedule,
    Schedule.recurs(Math.max(0, max - 1))
  );
  if (policy.shouldRetry) {
    const predicate = policy.shouldRetry;
    let attempt = 1;
    schedule = Schedule.whileInput(schedule, (input: unknown) => {
      const currentAttempt = attempt;
      attempt += 1;
      return predicate(input, currentAttempt);
    });
  }
  return schedule;
}

function backoffSchedule(
  backoff?: BackoffStrategy
): Schedule.Schedule<unknown> {
  if (!backoff) {
    return Schedule.spaced(0);
  }
  switch (backoff.kind) {
    case "fixed":
      return Schedule.spaced(parseDuration(backoff.delay));
    case "exponential":
      return Schedule.exponential(
        parseDuration(backoff.initial),
        backoff.factor ?? 2
      );
    case "linear":
      return Schedule.linear(parseDuration(backoff.step)).pipe(
        Schedule.addDelay((_) => parseDuration(backoff.initial))
      );
    case "jittered":
      return Schedule.jittered(
        Schedule.exponential(parseDuration(backoff.initial))
      );
    default:
      break;
  }
  return undefined as never;
}
