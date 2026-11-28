import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ScheduleDispatch,
  type Schedule as StoredSchedule,
} from "@foundry/scheduling";
import { Catalog, monitor, step } from "@foundry.sh/marbles";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectInput } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import type { ScheduledEngine } from "~/lib/schedule";
import { registration } from "~/lib/schedule";
import { ScheduleDispatcher } from "~/lib/schedule-dispatch";
import { MemoryTriggerStore } from "~/lib/trigger-store";
import type { Schedule } from "~/lib/triggers";
import { runStoreEffect } from "~/lib/workflow-runs";
import { startEngine } from "./helpers/engine";
import { occurrencesOf, startScheduler } from "./helpers/schedules";
import { temporaryDirectory } from "./helpers/temporary";

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.dispose();
  }
});

function every(key: string, ms: number, workflow = key): Schedule {
  return {
    input: null,
    key,
    kind: "schedule",
    label: key,
    trigger: { kind: "interval", ms },
    workflow,
  };
}

async function engineWith(
  collect: CollectInput,
  ...schedules: Schedule[]
): Promise<Engine> {
  const engine = await startEngine({ collect, print: () => undefined });
  engines.push(engine);
  for (const schedule of schedules) {
    engine.schedule(schedule);
  }
  return engine;
}

function fakeEngine(
  schedules: () => Promise<readonly Schedule[]>,
  launched: string[],
  paused: () => readonly Schedule[] = () => []
): ScheduledEngine {
  return {
    automations: { paused: () => Promise.resolve(paused()) },
    cancel: () => Promise.resolve(),
    executions: { peek: () => Promise.resolve(undefined) },
    has: () => true,
    launch: (name: string) => {
      launched.push(name);
      return Promise.resolve({ id: "rn-fake", result: Promise.resolve() });
    },
    schedules,
    triggers: new MemoryTriggerStore(),
  } as unknown as ScheduledEngine;
}

describe("the schedule loop", { timeout: 20_000 }, () => {
  it("dispatches an interval once its delay passed, and again only a delay after its run settled", async () => {
    const ends: number[] = [];
    const starts: number[] = [];
    const beat = step("beat").do(async () => {
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 50));
      ends.push(Date.now());
    });
    const engine = await engineWith([beat], every("beat", 100));
    const scheduler = startScheduler(engine);
    await vi.waitFor(() => expect(starts.length).toBeGreaterThanOrEqual(2), {
      interval: 50,
      timeout: 10_000,
    });
    await scheduler.stop();
    expect((starts[1] ?? 0) - (ends[0] ?? 0)).toBeGreaterThanOrEqual(100);
    const [first] = await occurrencesOf(engine, "beat");
    expect(first?.state).toMatchObject({
      kind: "settled",
      outcome: "complete",
    });
  });

  it("records a launch it cannot start as a failed occurrence, and says so", async () => {
    const engine = await engineWith([], every("orphan", 100, "gone"));
    const scheduler = startScheduler(engine);
    await vi.waitFor(
      async () =>
        expect((await occurrencesOf(engine, "orphan"))[0]?.state).toMatchObject(
          { kind: "settled", outcome: "failed" }
        ),
      { interval: 50, timeout: 10_000 }
    );
    await scheduler.stop();
    expect(
      scheduler.lines.some((line) =>
        line.startsWith("[schedule] orphan failed:")
      )
    ).toBe(true);
  });

  it("launches nothing once stopped before anything was due", async () => {
    const launched: string[] = [];
    const engine = fakeEngine(
      () => Promise.resolve([every("later", 200)]),
      launched
    );
    const scheduler = startScheduler(engine);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(launched).toEqual([]);
  });

  it("never dispatches a stored schedule that is no longer declared, and removes it", async () => {
    const launched: string[] = [];
    const engine = fakeEngine(() => Promise.resolve([]), launched);
    const store = await engine.triggers.schedules();
    await runStoreEffect(
      store.commit({
        cursors: [{ nextDueAt: 0, scheduleId: "old" }],
        schedules: [
          {
            cadence: { afterSettleMs: 1000, kind: "delay" },
            createdAt: 0,
            id: "old",
            misfire: "run-once",
            overlap: "skip",
            state: "active",
            target: { handler: { name: "old" }, input: null },
          },
        ],
      })
    );
    const scheduler = startScheduler(engine);
    await vi.waitFor(
      async () => expect(await runStoreEffect(store.listSchedules)).toEqual([]),
      { interval: 50, timeout: 10_000 }
    );
    await scheduler.stop();
    expect(launched).toEqual([]);
    expect(
      scheduler.lines.some((line) =>
        line.startsWith("[schedule] schedule evaluation failed")
      )
    ).toBe(true);
  });

  it("pauses a disabled automation's schedule, keeping its cursor, and resumes it where it was", async () => {
    const launched: string[] = [];
    const hourly: Schedule = { ...every("hourly", 3_600_000), registeredAt: 0 };
    const automation: { enabled: boolean } = { enabled: false };
    const engine = fakeEngine(
      () => Promise.resolve(automation.enabled ? [hourly] : []),
      launched,
      () => (automation.enabled ? [] : [hourly])
    );
    const store = await engine.triggers.schedules();
    const first = registration(hourly, undefined, 0);
    if (first === undefined) {
      throw new Error("expected a registration");
    }
    const cursor = { nextDueAt: Date.now() + 3_600_000, scheduleId: "hourly" };
    await runStoreEffect(
      store.commit({
        cursors: [cursor],
        schedules: [
          {
            ...first,
            createdAt: 0,
            misfire: "run-once",
            overlap: "skip",
            state: "active",
          },
        ],
      })
    );
    const stateOf = async () =>
      (await runStoreEffect(store.getSchedule("hourly")))?.state;
    const scheduler = startScheduler(engine);
    await vi.waitFor(async () => expect(await stateOf()).toBe("paused"), {
      interval: 50,
      timeout: 10_000,
    });
    automation.enabled = true;
    await vi.waitFor(async () => expect(await stateOf()).toBe("active"), {
      interval: 50,
      timeout: 10_000,
    });
    await scheduler.stop();
    expect(await runStoreEffect(store.getCursor("hourly"))).toEqual(cursor);
    expect(launched).toEqual([]);
  });

  it("launches one run for an occurrence submitted again after its commit failed", async () => {
    const launched: string[] = [];
    const engine = fakeEngine(
      () => Promise.resolve([every("again", 60_000)]),
      launched
    );
    const dispatcher = new ScheduleDispatcher(engine, {
      cancel: new AbortController().signal,
      print: () => undefined,
    });
    const submit = Effect.flatMap(ScheduleDispatch, (dispatch) =>
      dispatch.submit({
        idempotencyKey: "again:1",
        scheduledFor: 1,
        scheduleId: "again",
        target: { handler: { name: "again" }, input: null },
      })
    ).pipe(Effect.provide(dispatcher.layer));
    const first = await Effect.runPromise(submit);
    expect(await Effect.runPromise(submit)).toEqual(first);
    expect(launched).toEqual(["again"]);
  });

  it("launches one run for an occurrence a restarted dispatcher submits again", async () => {
    const finish = Promise.withResolvers<void>();
    const againStep = step("again").do(() => finish.promise);
    const engine = await engineWith([againStep], every("again", 60_000));
    const request = {
      idempotencyKey: "again:1",
      scheduledFor: 1,
      scheduleId: "again",
      target: { handler: { name: "again" }, input: null },
    };
    const submitThrough = (dispatcher: ScheduleDispatcher) =>
      Effect.runPromise(
        Effect.flatMap(ScheduleDispatch, (dispatch) =>
          dispatch.submit(request)
        ).pipe(Effect.provide(dispatcher.layer))
      );
    const dispatcherFor = () =>
      new ScheduleDispatcher(engine, {
        cancel: new AbortController().signal,
        print: () => undefined,
      });
    const first = await submitThrough(dispatcherFor());
    const again = await submitThrough(dispatcherFor());
    finish.resolve();
    expect(again).toEqual(first);
    expect(engine.executions.list().map((run) => run.id)).toEqual([
      first.jobId,
    ]);
  });

  it("reports a failed read of the schedules and reads them again", async () => {
    const launched: string[] = [];
    let reads = 0;
    const engine = fakeEngine(() => {
      reads += 1;
      return reads === 1
        ? Promise.reject(new Error("database busy"))
        : Promise.resolve([every("read", 50)]);
    }, launched);
    const scheduler = startScheduler(engine);
    await vi.waitFor(() => expect(launched).toEqual(["read"]), {
      interval: 50,
      timeout: 10_000,
    });
    await scheduler.stop();
    expect(scheduler.lines).toContain(
      "[schedule] reading schedules failed: Error: database busy"
    );
  });

  it("cancels the runs it started when its cancel signal aborts", async () => {
    const started = Promise.withResolvers<void>();
    const hold = step("hold").do(async ({ signal }) => {
      started.resolve();
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true })
      );
      signal.throwIfAborted();
    });
    const engine = await engineWith([hold], every("hold", 50));
    const scheduler = startScheduler(engine);
    await started.promise;
    await scheduler.stop();
    expect(
      engine.executions.list().map((run) => [run.name, run.status])
    ).toEqual([["hold", "cancelled"]]);
  });

  it("stops waiting for a run it started once that run is suspended, leaving it suspended", async () => {
    const hold = step("hold").do(({ ask }) =>
      ask.question({ title: "Go on?" })
    );
    const engine = await startEngine({
      askable: true,
      collect: [hold],
      print: () => undefined,
    });
    engines.push(engine);
    engine.schedule(every("hold", 50));
    const cancel = new AbortController();
    const scheduler = startScheduler(engine, { cancel: cancel.signal });
    const jobOf = async () => {
      const [occurrence] = await occurrencesOf(engine, "hold");
      return occurrence?.state.kind === "dispatched"
        ? occurrence.state.jobId
        : "";
    };
    await vi.waitFor(async () =>
      expect(engine.executions.get(await jobOf())?.status).toBe("suspended")
    );
    await scheduler.stop();
    expect(engine.executions.get(await jobOf())?.status).toBe("suspended");
  });

  it("starts a monitor's launch once its detector ended, and polls again a delay after the detector", async () => {
    const root = temporaryDirectory("marbles-schedule-loop-");
    writeFileSync(join(root, "guide.md"), "one\n");
    const shipped: number[] = [];
    const ship = step("ship").do(async () => {
      shipped.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });
    const watched = monitor("**/*.md")
      .every("1s")
      .do(() => ship({}));
    const collected = Catalog.collect([ship, watched]);
    const engine = await startEngine({
      catalog: collected,
      print: () => undefined,
      root,
    });
    engines.push(engine);
    const [key] = [...collected.monitors.keys()] as [string];
    const scheduler = startScheduler(engine);
    await vi.waitFor(
      async () =>
        expect(
          (await occurrencesOf(engine, key)).filter(
            ({ state }) => state.kind === "settled"
          ).length
        ).toBeGreaterThanOrEqual(2),
      { interval: 100, timeout: 20_000 }
    );
    await scheduler.stop();
    expect(shipped).toHaveLength(1);
    expect((await engine.triggers.monitorState(key))?.pending).toBeUndefined();
  }, 30_000);
});

describe("a schedule's registration", () => {
  const hourly: Schedule = { ...every("hourly", 3_600_000), registeredAt: 0 };

  it("first dispatches an interval its own delay after it was registered", () => {
    expect(registration(hourly, undefined, 1_000_000)).toMatchObject({
      cadence: {
        afterSettleMs: 3_600_000,
        initialDelayMs: 2_600_000,
        kind: "delay",
      },
      id: "hourly",
      misfire: "run-once",
      overlap: "skip",
    });
    expect(registration(hourly, undefined, 5_000_000)?.cadence).toMatchObject({
      initialDelayMs: 0,
    });
  });

  it("leaves a stored schedule alone, its first deadline included, until what it dispatches changes", () => {
    const first = registration(hourly, undefined, 1_000_000);
    if (first === undefined) {
      throw new Error("expected a registration");
    }
    const stored: StoredSchedule = {
      ...first,
      createdAt: 1_000_000,
      misfire: "run-once",
      overlap: "skip",
      state: "active",
    };
    expect(registration(hourly, stored, 2_000_000)).toBeUndefined();
    expect(
      registration({ ...hourly, input: { more: true } }, stored, 2_000_000)
    ).toMatchObject({ cadence: stored.cadence });
    expect(
      registration(
        { ...hourly, trigger: { kind: "interval", ms: 60_000 } },
        stored,
        2_000_000
      )?.cadence
    ).toEqual({ afterSettleMs: 60_000, initialDelayMs: 0, kind: "delay" });
  });
});
