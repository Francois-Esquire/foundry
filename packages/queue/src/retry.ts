import { Effect, Random } from "effect";
import type { Backoff, Instant, Job } from "./domain";

const DEFAULT_FACTOR = 2;

const capped = (delay: number, maxDelayMs: number | undefined) =>
  Math.round(Math.min(delay, maxDelayMs ?? Number.POSITIVE_INFINITY));

const backoffDelay = (
  backoff: Backoff | undefined,
  retry: number
): Effect.Effect<number> => {
  if (backoff === undefined) {
    return Effect.succeed(0);
  }
  switch (backoff.kind) {
    case "fixed":
      return Effect.succeed(backoff.delayMs);
    case "linear":
      return Effect.succeed(
        capped(
          backoff.initialMs + backoff.stepMs * (retry - 1),
          backoff.maxDelayMs
        )
      );
    case "exponential":
      return Effect.succeed(
        capped(
          backoff.initialMs * (backoff.factor ?? DEFAULT_FACTOR) ** (retry - 1),
          backoff.maxDelayMs
        )
      );
    case "jittered":
      return Effect.map(Random.next, (random) => {
        const ceiling = capped(
          backoff.initialMs * (backoff.factor ?? DEFAULT_FACTOR) ** (retry - 1),
          backoff.maxDelayMs
        );
        return Math.round(ceiling / 2 + (random * ceiling) / 2);
      });
    default:
      return Effect.succeed(0);
  }
};

export const nextAttemptAt = (
  job: Job,
  attempt: number,
  now: Instant
): Effect.Effect<Instant | undefined> => {
  const { retry } = job.policy;
  if (retry === undefined || attempt >= retry.maxAttempts) {
    return Effect.succeed(undefined);
  }
  return Effect.map(backoffDelay(retry.backoff, attempt), (delay) => {
    const at = now + delay;
    const elapsed = at - job.createdAt;
    return retry.maxElapsedMs !== undefined && elapsed > retry.maxElapsedMs
      ? undefined
      : at;
  });
};
