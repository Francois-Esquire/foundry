import { afterEach, describe, expect, it } from "vitest";
import type { ScheduleHistory, TriggerStore } from "~/lib/trigger-store";

/**
 * Where a trigger store under test comes from: `store()` makes another
 * over the same state, as a second engine would have. `close` ends
 * whatever the stores were made over.
 */
export interface TriggerStoreFixture {
  close(): Promise<void>;
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

    it("refuses every call once closed", async () => {
      const triggers = await store();
      await triggers.close();
      await expect(triggers.claimTick("s")).rejects.toThrow();
      await expect(triggers.lastTick("s")).rejects.toThrow();
      await expect(triggers.monitorState("m")).rejects.toThrow();
    });
  });
}
