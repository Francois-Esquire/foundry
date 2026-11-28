import { Duration, Effect, Schedule } from "effect";
import { describe, expect, test } from "vitest";

import { parseDuration, toSchedule } from "../retry-schedule";

const UNPARSEABLE_DURATION_PATTERN = /Unparseable duration/;

describe("parseDuration", () => {
  test("number ms passes through unchanged", () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(123)).toBe(123);
    expect(parseDuration(1.5)).toBe(1.5);
  });

  test("suffix strings parse to the expected ms value (ms / s / m / h)", () => {
    const cases: [string, number][] = [
      ["100ms", 100],
      ["1.5ms", 1.5],
      ["2s", 2000],
      ["0.5s", 500],
      ["3m", 180_000],
      ["1h", 3_600_000],
      ["0.5h", 1_800_000],
    ];
    for (const [input, expected] of cases) {
      expect(parseDuration(input)).toBe(expected);
    }
  });

  test("leading/trailing whitespace is tolerated", () => {
    expect(parseDuration("  100ms  ")).toBe(100);
  });

  test("unparseable strings throw", () => {
    const cases = ["", "abc", "10x", "1d", "1.2.3s", "100 ms"];
    for (const input of cases) {
      expect(() => parseDuration(input)).toThrow(UNPARSEABLE_DURATION_PATTERN);
    }
  });
});

async function delaysMs(
  schedule: Schedule.Schedule<unknown>,
  n: number
): Promise<number[]> {
  const inputs = Array.from({ length: n }, () => undefined);
  const out = await Effect.runPromise(
    Schedule.run(Schedule.delays(schedule), 0, inputs)
  );
  return Array.from(out).map((d) => Duration.toMillis(d));
}

describe("toSchedule — per-strategy", () => {
  test("no backoff: spaced(0) — every recur emits zero delay", async () => {
    const sched = toSchedule({ maxAttempts: 5 });
    const delays = await delaysMs(sched, 4);
    expect(delays).toEqual([0, 0, 0, 0]);
  });

  test("fixed backoff: every iteration emits the configured delay", async () => {
    const sched = toSchedule({
      backoff: { delay: 50, kind: "fixed" },
      maxAttempts: 5,
    });
    const delays = await delaysMs(sched, 3);
    expect(delays).toEqual([50, 50, 50]);
  });

  test("exponential backoff: delays grow by `factor` each iteration", async () => {
    const sched = toSchedule({
      backoff: { factor: 2, initial: 100, kind: "exponential" },
      maxAttempts: 5,
    });
    const delays = await delaysMs(sched, 3);
    expect(delays).toEqual([100, 200, 400]);
  });

  test("linear backoff: first delay = step (Schedule.linear semantics + addDelay)", async () => {
    const sched = toSchedule({
      backoff: { initial: 100, kind: "linear", step: 50 },
      maxAttempts: 5,
    });
    const delays = await delaysMs(sched, 3);
    expect(delays).toEqual([150, 200, 250]);
  });

  test("jittered backoff: delays are non-negative finite numbers", async () => {
    const sched = toSchedule({
      backoff: { initial: 100, kind: "jittered", max: 1000 },
      maxAttempts: 5,
    });
    const delays = await delaysMs(sched, 3);
    expect(delays).toHaveLength(3);
    for (const d of delays) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  test("maxAttempts caps the schedule via intersect with recurs(max-1)", async () => {
    const sched = toSchedule({
      backoff: { delay: 10, kind: "fixed" },
      maxAttempts: 3,
    });
    const delays = await delaysMs(sched, 100);
    expect(delays.length).toBeLessThan(100);
  });

  test("shouldRetry predicate receives the failure and a 1-based attempt counter", async () => {
    const seen: { err: unknown; attempt: number }[] = [];
    const sched = toSchedule({
      maxAttempts: 5,
      shouldRetry: (err, attempt) => {
        seen.push({ attempt, err });
        return attempt < 3;
      },
    });
    await Effect.runPromise(
      Schedule.run(sched, 0, [
        new Error("a"),
        new Error("b"),
        new Error("c"),
        new Error("d"),
      ])
    );
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(seen.map((s) => (s.err as Error).message)).toEqual(["a", "b", "c"]);
  });
});
