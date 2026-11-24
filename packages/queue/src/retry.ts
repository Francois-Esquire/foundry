import { Effect, Random } from "effect";
import {
  type Backoff,
  type Instant,
  InvalidRetryPolicyError,
  type Job,
  type RetryPolicy,
} from "./domain";

const DEFAULT_FACTOR = 2;

const unknownBackoff = (backoff: never): string =>
  `backoff kind ${JSON.stringify(backoff)} must be fixed, linear, exponential, or jittered`;

const atLeastZero = (value: number | undefined) =>
  value === undefined || (Number.isFinite(value) && value >= 0);

const backoffProblem = (backoff: Backoff | undefined): string | undefined => {
  if (backoff === undefined) {
    return;
  }
  switch (backoff.kind) {
    case "fixed":
      return atLeastZero(backoff.delayMs)
        ? undefined
        : "backoff delayMs must be a finite number of at least 0";
    case "linear":
      return atLeastZero(backoff.initialMs) &&
        atLeastZero(backoff.stepMs) &&
        atLeastZero(backoff.maxDelayMs)
        ? undefined
        : "linear backoff delays must be finite numbers of at least 0";
    case "exponential":
    case "jittered":
      return atLeastZero(backoff.initialMs) &&
        atLeastZero(backoff.maxDelayMs) &&
        (backoff.factor === undefined ||
          (Number.isFinite(backoff.factor) && backoff.factor >= 1))
        ? undefined
        : `${backoff.kind} backoff needs finite delays of at least 0 and a finite factor of at least 1`;
    default:
      return unknownBackoff(backoff);
  }
};

export const checkRetryPolicy = (
  policy: RetryPolicy | undefined
): Effect.Effect<void, InvalidRetryPolicyError> => {
  if (policy === undefined) {
    return Effect.void;
  }
  const reason =
    Number.isInteger(policy.maxAttempts) && policy.maxAttempts >= 1
      ? (backoffProblem(policy.backoff) ??
        (atLeastZero(policy.maxElapsedMs)
          ? undefined
          : "maxElapsedMs must be a finite number of at least 0"))
      : "maxAttempts must be an integer of at least 1";
  return reason === undefined
    ? Effect.void
    : Effect.fail(new InvalidRetryPolicyError({ reason }));
};

const capped = (delay: number, maxDelayMs: number | undefined) =>
  Math.round(Math.min(delay, maxDelayMs ?? Number.POSITIVE_INFINITY));

const growing = (
  backoff: Extract<Backoff, { kind: "exponential" | "jittered" }>,
  retry: number
) =>
  capped(
    backoff.initialMs * (backoff.factor ?? DEFAULT_FACTOR) ** (retry - 1),
    backoff.maxDelayMs
  );

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
      return Effect.succeed(growing(backoff, retry));
    case "jittered":
      return Effect.map(Random.next, (random) => {
        const ceiling = growing(backoff, retry);
        return Math.round(ceiling / 2 + (random * ceiling) / 2);
      });
    default:
      return Effect.as(Effect.logWarning(unknownBackoff(backoff)), 0);
  }
};

export const nextAttemptAt = (
  job: Job,
  attempt: number,
  now: Instant
): Effect.Effect<Instant | undefined> => {
  const { retry } = job.policy;
  if (
    retry === undefined ||
    !Number.isInteger(retry.maxAttempts) ||
    attempt >= retry.maxAttempts
  ) {
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
