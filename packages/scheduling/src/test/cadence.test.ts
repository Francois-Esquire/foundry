import { Effect, Either } from "effect";
import { describe, expect, test } from "vitest";
import {
  dueOccurrences,
  nextDue,
  parseEvery,
  validateCadence,
} from "../cadence";
import type { Cadence } from "../domain";

const at = (iso: string) => Date.parse(iso);

describe("cadence", () => {
  test("an interval is due every period after the reference", () => {
    const cadence: Cadence = { everyMs: 1000, kind: "interval" };
    expect(nextDue(cadence, 5000)).toBe(6000);
    expect(dueOccurrences(cadence, 6000, 5999, "run-once")).toEqual({
      nextDueAt: 6000,
      skipped: [],
      toFire: null,
    });
    expect(dueOccurrences(cadence, 6000, 6400, "skip")).toEqual({
      nextDueAt: 7000,
      skipped: [],
      toFire: 6000,
    });
  });

  test("a calendar cadence fires at its wall-clock time on its weekdays in its timezone", () => {
    const cadence: Cadence = {
      hour: 9,
      kind: "calendar",
      minute: 30,
      timezone: "America/New_York",
      weekdays: ["mon", "fri"],
    };
    const wednesday = at("2026-01-07T12:00:00.000Z");
    const friday = at("2026-01-09T14:30:00.000Z");
    expect(nextDue(cadence, wednesday)).toBe(friday);
    expect(nextDue(cadence, friday)).toBe(at("2026-01-12T14:30:00.000Z"));
  });

  test("a cron cadence fires strictly after the reference", () => {
    const cadence: Cadence = {
      expression: "*/15 * * * *",
      kind: "cron",
      timezone: "UTC",
    };
    expect(nextDue(cadence, at("2026-01-07T10:07:00.000Z"))).toBe(
      at("2026-01-07T10:15:00.000Z")
    );
    expect(nextDue(cadence, at("2026-01-07T10:15:00.000Z"))).toBe(
      at("2026-01-07T10:30:00.000Z")
    );
  });

  test("a once cadence fires a single time and is then exhausted", () => {
    const cadence: Cadence = { at: 2000, kind: "once" };
    expect(nextDue(cadence, 1000)).toBe(2000);
    expect(nextDue(cadence, 2000)).toBeNull();
    expect(dueOccurrences(cadence, 2000, 9000, "skip")).toEqual({
      nextDueAt: null,
      skipped: [],
      toFire: 2000,
    });
  });

  test("when several due times elapsed, run-once fires the latest and skip fires none", () => {
    const cadence: Cadence = { everyMs: 1000, kind: "interval" };
    expect(dueOccurrences(cadence, 1000, 3500, "run-once")).toEqual({
      nextDueAt: 4000,
      skipped: [1000, 2000],
      toFire: 3000,
    });
    expect(dueOccurrences(cadence, 1000, 3500, "skip")).toEqual({
      nextDueAt: 4000,
      skipped: [1000, 2000, 3000],
      toFire: null,
    });
    const cron: Cadence = {
      expression: "0 * * * *",
      kind: "cron",
      timezone: "UTC",
    };
    const start = at("2026-01-07T00:00:00.000Z");
    const later = dueOccurrences(
      cron,
      start,
      start + 2.5 * 3_600_000,
      "run-once"
    );
    expect(later.toFire).toBe(start + 2 * 3_600_000);
    expect(later.skipped).toEqual([start, start + 3_600_000]);
    expect(later.nextDueAt).toBe(start + 3 * 3_600_000);
  });

  test("invalid cadences are rejected and durations parse into intervals", async () => {
    const invalid: Cadence[] = [
      { everyMs: 0, kind: "interval" },
      { hour: 24, kind: "calendar", minute: 0, timezone: "UTC" },
      { hour: 9, kind: "calendar", minute: 0, timezone: "Mars/Olympus" },
      { expression: "99 * * * *", kind: "cron", timezone: "UTC" },
    ];
    const results = await Effect.runPromise(
      Effect.forEach(invalid, (cadence) =>
        Effect.flip(validateCadence(cadence))
      )
    );
    expect(results.map((error) => error._tag)).toEqual(
      invalid.map(() => "InvalidCadenceError")
    );
    expect(parseEvery("5m")).toEqual(
      Either.right({ everyMs: 300_000, kind: "interval" })
    );
    expect(Either.isLeft(parseEvery("soon"))).toBe(true);
  });
});
