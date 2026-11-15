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

/** The contract every `TriggerStore` keeps, whatever it keeps the state in. */
export function describeTriggerStore(
  name: string,
  open: () => Promise<TriggerStoreFixture>
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

    it("holds a trigger's tick for one caller at a time, its own next tick included", async () => {
      const first = await store();
      const second = await store();
      expect(await first.claimTick("s")).toEqual({ claimed: true });
      expect(await first.claimTick("s")).toEqual({
        claimed: false,
        holder: "this process",
      });
      expect(await second.claimTick("s")).toMatchObject({ claimed: false });
      expect(await second.claimTick("t")).toEqual({ claimed: true });

      await first.finishTick("s");
      expect(await second.claimTick("s")).toEqual({ claimed: true });
    });

    it("records a tick and gives up its claim in one write, for any store over the same state", async () => {
      const first = await store();
      const second = await store();
      expect(await first.lastTick("s")).toBeUndefined();
      await first.claimTick("s");
      await first.finishTick("s", TICK);

      expect(await second.lastTick("s")).toEqual(TICK);
      expect(await second.claimTick("s")).toEqual({ claimed: true });
      // A tick that did not run keeps the last one's record.
      await second.finishTick("s");
      expect(await first.lastTick("s")).toEqual(TICK);
    });

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

    it("keeps a monitor's state whole, its pending launch until it is saved without one", async () => {
      const triggers = await store();
      expect(await triggers.monitorState("m")).toBeUndefined();
      await triggers.saveMonitorState("m", {
        observed: { files: { "a.md": "hash" } },
        pending: { input: { task: "a" }, workflow: "ship" },
      });
      const other = await store();
      expect(await other.monitorState("m")).toEqual({
        observed: { files: { "a.md": "hash" } },
        pending: { input: { task: "a" }, workflow: "ship" },
      });
      await other.saveMonitorState("m", { observed: { files: {} } });
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
