import type { Occurrence, Schedule, ScheduleCursor } from "@foundry/scheduling";
import { afterEach, describe, expect, it } from "vitest";
import { NotStorableError } from "~/lib/state/json";
import type { MonitorState, TriggerStore } from "~/lib/trigger-store";
import { runStoreEffect as run } from "~/lib/workflow-runs";

export interface TriggerStoreFixture {
  close(): Promise<void>;
  store(): TriggerStore;
}

const SCHEDULE: Schedule = {
  cadence: { afterSettleMs: 60_000, kind: "delay" },
  createdAt: 1000,
  id: "s",
  misfire: "run-once",
  overlap: "skip",
  state: "active",
  target: {
    handler: { name: "tidy" },
    input: { input: null, kind: "schedule", label: "tidy" },
  },
};

const CURSOR: ScheduleCursor = { nextDueAt: 61_000, scheduleId: "s" };

const OCCURRENCE: Occurrence = {
  id: "s:61000",
  scheduledFor: 61_000,
  scheduleId: "s",
  state: {
    jobId: "rn-1",
    kind: "settled",
    outcome: "complete",
    settledAt: 62_000,
  },
};

export function describeTriggerStore(
  name: string,
  open: () => Promise<TriggerStoreFixture>,
  { shared }: { readonly shared: boolean }
): void {
  describe(name, () => {
    let fixture: TriggerStoreFixture | undefined;
    const made: TriggerStore[] = [];
    const store = async () => {
      fixture ??= await open();
      const triggers = fixture.store();
      made.push(triggers);
      return triggers;
    };

    afterEach(async () => {
      for (const triggers of made.splice(0)) {
        await triggers.close().catch(() => undefined);
      }
      await fixture?.close();
      fixture = undefined;
    });

    it("keeps each schedule, its cursor and its occurrences in its schedule store", async () => {
      const schedules = await (await store()).schedules();
      await run(
        schedules.commit({
          cursors: [CURSOR],
          occurrences: [OCCURRENCE],
          schedules: [SCHEDULE],
        })
      );
      expect(await run(schedules.getSchedule("s"))).toEqual(SCHEDULE);
      expect(await run(schedules.getCursor("s"))).toEqual(CURSOR);
      expect(await run(schedules.latestOccurrence("s"))).toEqual(OCCURRENCE);
      expect(await run(schedules.getSchedule("t"))).toBeUndefined();
    });

    it.runIf(shared)(
      "shares one workspace's schedule store between engines",
      async () => {
        const first = await (await store()).schedules();
        await run(first.commit({ cursors: [CURSOR], schedules: [SCHEDULE] }));
        const second = await (await store()).schedules();
        expect(await run(second.listSchedules)).toEqual([SCHEDULE]);
        expect(await run(second.getCursor("s"))).toEqual(CURSOR);
      }
    );

    it("keeps a monitor's state whole, and its pending launch until it is cleared", async () => {
      const triggers = await store();
      expect(await triggers.monitorState("m")).toBeUndefined();
      await triggers.saveMonitorState("m", {
        observed: { files: { "a.md": "hash" } },
        pending: { input: { task: "a" }, workflow: "ship" },
      });
      expect(await triggers.monitorState("m")).toEqual({
        observed: { files: { "a.md": "hash" } },
        pending: { input: { task: "a" }, workflow: "ship" },
      });
      await triggers.clearPendingLaunch("m");
      await triggers.clearPendingLaunch("never-seen");
      expect(await triggers.monitorState("m")).toEqual({
        observed: { files: { "a.md": "hash" } },
      });
      expect(await triggers.monitorState("never-seen")).toBeUndefined();
      await triggers.saveMonitorState("m", { observed: { files: {} } });
      expect(await triggers.monitorState("m")).toEqual({
        observed: { files: {} },
      });
    });

    it("forgets what a monitor kept under a key", async () => {
      const triggers = await store();
      await triggers.saveMonitorState("m", {
        observed: { files: {} },
        pending: { input: null, workflow: "ship" },
      });
      await triggers.saveMonitorState("kept", { observed: {} });
      await triggers.forgetMonitor("m");
      await triggers.forgetMonitor("never-seen");
      expect(await triggers.monitorState("m")).toBeUndefined();
      expect(await triggers.monitorState("kept")).toEqual({ observed: {} });
    });

    it("refuses, keeping what it had, a monitor state JSON would not give back as it is", async () => {
      const triggers = await store();
      const kept = { observed: { hash: "first" } };
      await triggers.saveMonitorState("m", kept);
      for (const state of [
        {
          observed: { hash: "x" },
          pending: { input: { amount: Number.NaN }, workflow: "flow" },
        },
        { observed: { big: Number.POSITIVE_INFINITY } },
        { observed: { seen: new Date(0) } },
        { observed: { list: [1, undefined] } },
        { observed: {}, pending: { input: 1n, workflow: "flow" } },
      ]) {
        await expect(
          triggers.saveMonitorState("m", state as unknown as MonitorState)
        ).rejects.toThrow(NotStorableError);
      }
      expect(await triggers.monitorState("m")).toEqual(kept);
    });

    it("keeps a monitor state in the form JSON gives back: -0 as 0, a property holding undefined left out", async () => {
      const triggers = await store();
      await triggers.saveMonitorState("m", {
        observed: { gone: undefined, zero: -0 },
        pending: { input: { n: -0, optional: undefined }, workflow: "ship" },
      });
      const kept = await triggers.monitorState("m");
      expect(kept).toEqual({
        observed: { zero: 0 },
        pending: { input: { n: 0 }, workflow: "ship" },
      });
      expect(Object.is(kept?.observed.zero, 0)).toBe(true);
      expect(Object.hasOwn(kept?.observed ?? {}, "gone")).toBe(false);
    });

    it("refuses every call once closed", async () => {
      const triggers = await store();
      await triggers.close();
      await expect(triggers.monitorState("m")).rejects.toThrow();
      await expect(triggers.forgetMonitor("m")).rejects.toThrow();
      await expect(triggers.schedules()).rejects.toThrow();
    });
  });
}
