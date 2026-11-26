import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type {
  DispatchTarget,
  Occurrence,
  Schedule,
  ScheduleCursor,
} from "../domain";
import type { ScheduleStoreService } from "../store/index";

type Open = () => ScheduleStoreService | Promise<ScheduleStoreService>;

const target: DispatchTarget = {
  handler: { name: "sync" },
  input: { full: true },
};

const schedule: Schedule = {
  cadence: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
  createdAt: 0,
  id: "nightly",
  misfire: "run-once",
  overlap: "skip",
  state: "active",
  target,
};

const claimed = (owner: number, scheduledFor = 1000): Occurrence => ({
  id: `nightly:${scheduledFor}`,
  scheduledFor,
  scheduleId: "nightly",
  state: {
    claimedAt: scheduledFor,
    kind: "claimed",
    lease: { claimedAt: scheduledFor, owner: { pid: owner, started: null } },
  },
});

const at = (scheduledFor: number, state: Occurrence["state"]): Occurrence => ({
  id: `nightly:${scheduledFor}`,
  scheduledFor,
  scheduleId: "nightly",
  state,
});

const skipped = (scheduledFor: number) =>
  at(scheduledFor, { at: scheduledFor, kind: "skipped", reason: "overlap" });

const byScheduledFor = (occurrences: readonly Occurrence[]) =>
  [...occurrences].sort((one, other) => one.scheduledFor - other.scheduledFor);

const run = async <A, E>(
  open: Open,
  body: (store: ScheduleStoreService) => Effect.Effect<A, E>
): Promise<A> => Effect.runPromise(body(await open()));

export function describeScheduleStore(name: string, open: Open): void {
  describe(`${name} schedule store conformance`, () => {
    describeReads(open);
    describeConflicts(open);
    describeClaims(open);
    describeRetention(open);
  });
}

function describeReads(open: Open): void {
  test("an empty store has no schedules, cursors, or occurrences", async () => {
    const result = await run(open, (store) =>
      Effect.all({
        cursor: store.getCursor("nightly"),
        latest: store.latestOccurrence("nightly"),
        occurrence: store.getOccurrence("nightly:1000"),
        occurrences: store.listOccurrences(),
        schedule: store.getSchedule("nightly"),
        schedules: store.listSchedules,
      })
    );
    expect(result).toEqual({
      cursor: undefined,
      latest: undefined,
      occurrence: undefined,
      occurrences: [],
      schedule: undefined,
      schedules: [],
    });
  });

  test("a commit reads back schedules, cursors, and occurrences, and removing a schedule removes all three", async () => {
    const dispatched = at(1000, {
      dispatchedAt: 1000,
      jobId: "jb-1",
      kind: "dispatched",
    });
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.commit({
          cursors: [{ nextDueAt: 2000, scheduleId: "nightly" }],
          events: [
            { at: 0, id: "ev-1", schedule, type: "schedule.registered" },
          ],
          occurrences: [dispatched, skipped(500)],
          schedules: [schedule],
        });
        const read = yield* Effect.all({
          cursor: store.getCursor("nightly"),
          dispatched: store.listOccurrences({
            scheduleId: "nightly",
            state: "dispatched",
          }),
          occurrence: store.getOccurrence(dispatched.id),
          occurrences: store.listOccurrences({ scheduleId: "nightly" }),
          schedule: store.getSchedule("nightly"),
          schedules: store.listSchedules,
        });
        yield* store.commit({ removed: ["nightly"] });
        const removed = yield* Effect.all([
          store.getSchedule("nightly"),
          store.getCursor("nightly"),
          store.listOccurrences(),
        ]);
        return { read, removed };
      })
    );
    expect(result.read).toEqual({
      cursor: { nextDueAt: 2000, scheduleId: "nightly" },
      dispatched: [dispatched],
      occurrence: dispatched,
      occurrences: [skipped(500), dispatched],
      schedule,
      schedules: [schedule],
    });
    expect(result.removed).toEqual([undefined, undefined, []]);
  });
}

function describeConflicts(open: Open): void {
  test("a commit expecting a cursor that moved fails with CursorConflictError and writes nothing", async () => {
    const read: ScheduleCursor = { nextDueAt: 1000, scheduleId: "nightly" };
    const moved: ScheduleCursor = {
      lastSettledAt: 900,
      nextDueAt: 1900,
      scheduleId: "nightly",
    };
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.commit({ cursors: [moved] });
        const conflict = yield* Effect.flip(
          store.commit({
            cursors: [{ nextDueAt: null, scheduleId: "nightly" }],
            expectedCursors: [read],
            occurrences: [claimed(7)],
            schedules: [schedule],
          })
        );
        const refused = yield* Effect.all({
          cursor: store.getCursor("nightly"),
          occurrence: store.getOccurrence("nightly:1000"),
          schedule: store.getSchedule("nightly"),
        });
        yield* store.commit({
          cursors: [{ ...moved, nextDueAt: 2900 }],
          expectedCursors: [moved],
        });
        return {
          conflict,
          cursor: yield* store.getCursor("nightly"),
          refused,
        };
      })
    );
    expect(result.conflict._tag).toBe("CursorConflictError");
    expect(result.conflict).toMatchObject({ scheduleId: "nightly" });
    expect(result.refused).toEqual({
      cursor: moved,
      occurrence: undefined,
      schedule: undefined,
    });
    expect(result.cursor).toEqual({ ...moved, nextDueAt: 2900 });
  });

  test("a commit expecting a schedule that changed fails with ScheduleConflictError and writes nothing", async () => {
    const paused: Schedule = { ...schedule, state: "paused" };
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.commit({ schedules: [schedule] });
        const conflict = yield* Effect.flip(
          store.commit({
            cursors: [{ nextDueAt: 3000, scheduleId: "nightly" }],
            expectedSchedules: [paused],
            occurrences: [claimed(7)],
            schedules: [paused],
          })
        );
        const refused = yield* Effect.all({
          cursor: store.getCursor("nightly"),
          occurrence: store.getOccurrence("nightly:1000"),
          schedule: store.getSchedule("nightly"),
        });
        yield* store.commit({
          expectedSchedules: [schedule],
          schedules: [paused],
        });
        return {
          conflict,
          refused,
          schedule: yield* store.getSchedule("nightly"),
        };
      })
    );
    expect(result.conflict._tag).toBe("ScheduleConflictError");
    expect(result.conflict).toMatchObject({ scheduleId: "nightly" });
    expect(result.refused).toEqual({
      cursor: undefined,
      occurrence: undefined,
      schedule,
    });
    expect(result.schedule).toEqual(paused);
  });

  test("a commit expecting a schedule that was never stored fails with ScheduleConflictError and writes nothing", async () => {
    const weekly: Schedule = { ...schedule, id: "weekly" };
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.commit({ schedules: [schedule] });
        const conflict = yield* Effect.flip(
          store.commit({ expectedSchedules: [weekly], schedules: [weekly] })
        );
        return { conflict, stored: yield* store.getSchedule("weekly") };
      })
    );
    expect(result.conflict).toMatchObject({
      _tag: "ScheduleConflictError",
      scheduleId: "weekly",
    });
    expect(result.stored).toBeUndefined();
  });
}

function describeClaims(open: Open): void {
  test("a claim inserts once; a second claim on the same occurrence loses", async () => {
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        const first = yield* store.claim(claimed(1));
        const second = yield* store.claim(claimed(2));
        return {
          first,
          second,
          stored: yield* store.getOccurrence("nightly:1000"),
        };
      })
    );
    expect(result).toEqual({
      first: true,
      second: false,
      stored: claimed(1),
    });
  });

  test("an exclusive claim is refused while another occurrence of the schedule is claimed", async () => {
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.claim(claimed(1));
        const blocked = yield* store.claim(claimed(2, 2000), undefined, true);
        const sameOccurrence = yield* store.claim(claimed(2), claimed(1), true);
        yield* store.releaseClaim("nightly:1000", { pid: 2, started: null });
        const afterRelease = yield* store.claim(
          claimed(2, 2000),
          undefined,
          true
        );
        return {
          afterRelease,
          blocked,
          blockedStored: yield* store.getOccurrence("nightly:2000"),
          sameOccurrence,
        };
      })
    );
    expect(result).toEqual({
      afterRelease: true,
      blocked: false,
      blockedStored: claimed(2, 2000),
      sameOccurrence: true,
    });
  });

  test("a claim is taken over only from the occurrence the taker read", async () => {
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.claim(claimed(1));
        const stale = yield* store.claim(claimed(3), claimed(2));
        const missing = yield* store.claim(claimed(3, 2000), claimed(2, 2000));
        const taken = yield* store.claim(claimed(2), claimed(1));
        return {
          missing,
          missingStored: yield* store.getOccurrence("nightly:2000"),
          stale,
          stored: yield* store.getOccurrence("nightly:1000"),
          taken,
        };
      })
    );
    expect(result).toEqual({
      missing: false,
      missingStored: undefined,
      stale: false,
      stored: claimed(2),
      taken: true,
    });
  });

  test("a claim is released only by its owner", async () => {
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.claim(claimed(7));
        yield* store.releaseClaim("nightly:1000", { pid: 8, started: null });
        const keptForOwner = yield* store.getOccurrence("nightly:1000");
        yield* store.releaseClaim("nightly:1000", { pid: 7, started: null });
        const released = yield* store.getOccurrence("nightly:1000");
        yield* store.commit({ occurrences: [skipped(2000)] });
        yield* store.releaseClaim("nightly:2000", { pid: 7, started: null });
        return {
          keptForOwner,
          released,
          unclaimed: yield* store.getOccurrence("nightly:2000"),
        };
      })
    );
    expect(result).toEqual({
      keptForOwner: claimed(7),
      released: undefined,
      unclaimed: skipped(2000),
    });
  });

  test("two claims racing on one store produce exactly one winner", async () => {
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        const wins = yield* Effect.all(
          [store.claim(claimed(1)), store.claim(claimed(2))],
          { concurrency: "unbounded" }
        );
        return { stored: yield* store.getOccurrence("nightly:1000"), wins };
      })
    );
    expect(result.wins.filter(Boolean)).toHaveLength(1);
    expect(result.stored).toEqual(claimed(result.wins[0] ? 1 : 2));
  });
}

function describeRetention(open: Open): void {
  test("a commit retaining occurrences keeps the newest terminal ones and every open one, and reads the latest", async () => {
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.commit({
          occurrences: [
            at(1, { dispatchedAt: 1, jobId: "jb-1", kind: "dispatched" }),
            ...[2, 3, 4, 5].map(skipped),
          ],
        });
        yield* store.commit({
          maxOccurrencesPerSchedule: 2,
          occurrences: [skipped(6)],
        });
        return {
          kept: yield* store.listOccurrences({ scheduleId: "nightly" }),
          latest: yield* store.latestOccurrence("nightly"),
        };
      })
    );
    expect(
      byScheduledFor(result.kept).map((occurrence) => occurrence.scheduledFor)
    ).toEqual([1, 5, 6]);
    expect(result.latest).toEqual(skipped(6));
  });

  test("retention prunes only the schedules the commit touched", async () => {
    const other = (scheduledFor: number): Occurrence => ({
      ...skipped(scheduledFor),
      id: `weekly:${scheduledFor}`,
      scheduleId: "weekly",
    });
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.commit({
          occurrences: [...[1, 2, 3].map(skipped), ...[1, 2, 3].map(other)],
        });
        yield* store.commit({
          maxOccurrencesPerSchedule: 1,
          occurrences: [skipped(4)],
        });
        return yield* Effect.all({
          nightly: store.listOccurrences({ scheduleId: "nightly" }),
          weekly: store.listOccurrences({ scheduleId: "weekly" }),
        });
      })
    );
    expect(byScheduledFor(result.nightly)).toEqual([skipped(4)]);
    expect(byScheduledFor(result.weekly)).toEqual([1, 2, 3].map(other));
  });

  test("listOccurrences returns occurrences in scheduledFor order", async () => {
    const result = await run(open, (store) =>
      Effect.gen(function* () {
        yield* store.commit({ occurrences: [skipped(3), skipped(1)] });
        yield* store.commit({ occurrences: [skipped(2)] });
        return yield* store.listOccurrences();
      })
    );
    expect(result.map((occurrence) => occurrence.scheduledFor)).toEqual([
      1, 2, 3,
    ]);
  });
}
