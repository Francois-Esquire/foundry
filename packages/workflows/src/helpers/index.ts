/**
 * Pure utilities: snapshot mutators, substrate primitives (sleep, duration
 * parsing, error serialization), and retry-to-schedule translation.
 */

import { Cause, Effect, Exit, Option, Schedule } from "effect";

import type { BackoffStrategy, Duration, RetryPolicy } from "../types";

/** Use a bound input only when the caller omitted one; explicit null is data. */
export function resolveInput<T>(input: T | undefined, bound: T): T {
  if (input === undefined) {
    return bound;
  }
  return input;
}

/**
 * Run an Effect to Promise, preserving the original typed error (not
 * FiberFailure wrapper). Composite primitives and Workflow.execute cross
 * Effect → Promise; this ensures instanceof checks remain valid.
 */
export function runEffectPromise<A>(
  effect: Effect.Effect<A, Error>
): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      throw failure.value;
    }
    const defect = Cause.dieOption(exit.cause);
    if (Option.isSome(defect)) {
      const d: unknown = defect.value;
      if (
        typeof d === "object" &&
        d !== null &&
        "_tag" in d &&
        d._tag === "UnknownException" &&
        "error" in d &&
        d.error instanceof Error
      ) {
        throw d.error;
      }
      throw d instanceof Error ? d : new Error(String(d));
    }
    throw new Error(Cause.pretty(exit.cause));
  });
}

/** Abortable sleep wrapping `setTimeout` + `AbortSignal`. */
export function sleepFor(
  duration: Duration,
  signal?: AbortSignal
): Promise<void> {
  const ms = parseDuration(duration);
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parse a {@link Duration} (`number` ms or `"5s"` / `"3m"` / `"2h"` string) to ms. */
export function parseDuration(d: Duration): number {
  if (typeof d === "number") {
    return d;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(d.trim());
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
    case undefined:
    default:
      throw new Error(`Unparseable duration: ${d}`);
  }
}

/** Capture an error into a serializable shape for snapshot records. */
export function errorToShape(err: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  return { message: String(err), name: "Error" };
}

/** Translate a {@link RetryPolicy} into an Effect {@link Schedule}. */
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
    schedule = Schedule.whileInput(schedule, (input: unknown) =>
      predicate(input, attempt++)
    );
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
  }
}
