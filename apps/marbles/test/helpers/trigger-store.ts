import { afterEach, describe, expect, it } from "vitest";
import { NotStorableError } from "~/lib/state/json";
import type {
  MonitorState,
  ScheduleHistory,
  TriggerStore,
} from "~/lib/trigger-store";

/**
 * Where a trigger store under test comes from: `store()` makes another
 * over the same state, as a second engine would have. `close` ends
 * whatever the stores were made over.
 */
export interface TriggerStoreFixture {
  close(): Promise<void>;
  /**
   * Keep `state` as the monitor `key`'s the way an older Marbles left it,
   * whatever is recorded for the key. Only a store that keeps state across
   * processes can hold what an older one left; one in memory has none.
   */
  leftover?(key: string, state: MonitorState): Promise<void>;
  store(): TriggerStore;
}

const TICK: ScheduleHistory = {
  kind: "monitor",
  label: "guides",
  lastFinish: "2026-09-10T01:00:00.000Z",
  lastStart: "2026-09-10T00:59:00.000Z",
  lastStatus: "complete",
  nextDue: "2026-09-10T01:30:00.000Z",
};

/**
 * The contract every `TriggerStore` keeps, whatever it keeps the state in.
 * `shared` says whether two stores from one fixture see one another's
 * state, as two engines over one database do, or each keeps its own, as
 * in memory.
 */
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

    it("holds a trigger's tick until it is finished, its own next tick included", async () => {
      const triggers = await store();
      expect(await triggers.claimTick("s")).toEqual({ claimed: true });
      expect(await triggers.claimTick("s")).toEqual({
        claimed: false,
        holder: "this process",
      });
      expect(await triggers.claimTick("t")).toEqual({ claimed: true });
      await triggers.finishTick("s");
      expect(await triggers.claimTick("s")).toEqual({ claimed: true });
    });

    it("records a tick and gives up its claim in one write", async () => {
      const triggers = await store();
      expect(await triggers.lastTick("s")).toBeUndefined();
      await triggers.claimTick("s");
      await triggers.finishTick("s", TICK);
      expect(await triggers.lastTick("s")).toEqual(TICK);
      expect(await triggers.claimTick("s")).toEqual({ claimed: true });
      // A tick that did not run keeps the last one's record.
      await triggers.finishTick("s");
      expect(await triggers.lastTick("s")).toEqual(TICK);
    });

    it.runIf(shared)(
      "holds one trigger's tick for one engine at a time, and gives a stopped engine's up",
      async () => {
        const first = await store();
        const second = await store();
        await first.claimTick("s");
        expect(await second.claimTick("s")).toMatchObject({ claimed: false });
        await first.finishTick("s", TICK);
        expect(await second.lastTick("s")).toEqual(TICK);

        expect(await second.claimTick("s")).toEqual({ claimed: true });
        // Stopping mid-tick gives the claim up at once.
        await second.close();
        expect(await first.claimTick("s")).toEqual({ claimed: true });
      }
    );

    it("refuses a tick record that is not one", async () => {
      const triggers = await store();
      await triggers.claimTick("s");
      await expect(
        triggers.finishTick("s", {
          ...TICK,
          lastStatus: "maybe",
        } as unknown as ScheduleHistory)
      ).rejects.toThrow();
    });

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

    it("drops what a monitor left under a key once a schedule's tick is recorded there, and keeps it for a monitor's", async () => {
      const triggers = await store();
      const left: MonitorState = {
        observed: { files: { "a.md": "hash" } },
        pending: { input: null, workflow: "ship" },
      };
      for (const key of ["watched", "rescheduled"]) {
        await triggers.saveMonitorState(key, left);
        expect(await triggers.claimTick(key)).toEqual({ claimed: true });
      }
      await triggers.finishTick("watched", TICK);
      await triggers.finishTick("rescheduled", { ...TICK, kind: "schedule" });
      expect(await triggers.monitorState("watched")).toEqual(left);
      expect(await triggers.monitorState("rescheduled")).toBeUndefined();
      expect((await triggers.lastTick("rescheduled"))?.kind).toBe("schedule");
    });

    it("marks a key a monitor's when a monitor keeps its state there, so the launch it leaves before its tick is recorded goes out again", async () => {
      const triggers = await store();
      const left: MonitorState = {
        observed: { files: { "a.md": "hash" } },
        pending: { input: null, workflow: "ship" },
      };
      expect(await triggers.claimTick("k")).toEqual({ claimed: true });
      await triggers.finishTick("k", { ...TICK, kind: "schedule" });
      // The monitor's first tick under the key keeps a launch, and stops.
      expect(await triggers.claimTick("k")).toEqual({ claimed: true });
      await triggers.saveMonitorState("k", left);
      expect((await triggers.lastTick("k"))?.kind).toBe("monitor");
      expect(await triggers.monitorState("k")).toEqual(left);
    });

    it("drops, where it would hand it out, what an older Marbles left under a key whose last tick is a schedule's", async ({
      skip,
    }) => {
      const triggers = await store();
      const leftover = fixture?.leftover;
      if (leftover === undefined) {
        skip("this store keeps nothing an older Marbles could have left");
        return;
      }
      const left: MonitorState = {
        observed: { files: {} },
        pending: { input: { old: true }, workflow: "obsolete-target" },
      };
      for (const [key, kind] of [
        ["rescheduled", "schedule"],
        ["watched", "monitor"],
      ] as const) {
        expect(await triggers.claimTick(key)).toEqual({ claimed: true });
        await triggers.finishTick(key, { ...TICK, kind });
        await leftover(key, left);
      }
      expect(await triggers.monitorState("rescheduled")).toBeUndefined();
      // Gone for good, for every store over the same state.
      expect(await (await store()).monitorState("rescheduled")).toBeUndefined();
      expect(await triggers.monitorState("watched")).toEqual(left);
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
      await expect(triggers.claimTick("s")).rejects.toThrow();
      await expect(triggers.lastTick("s")).rejects.toThrow();
      await expect(triggers.monitorState("m")).rejects.toThrow();
    });
  });
}
