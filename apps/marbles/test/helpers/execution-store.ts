import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionObservation } from "~/lib/executions/record";
import type { ExecutionStore } from "~/lib/executions/store";

export interface ExecutionStoreFixture {
  close(): Promise<void>;
  store(): ExecutionStore;
}

const AT = "2026-11-01T09:00:01.000Z";
const LATER = "2026-11-01T09:00:09.000Z";

function effect(id: string, status: "running" | "complete" = "complete") {
  return {
    data: { bytes: 1 },
    id,
    kind: "effect",
    startedAt: AT,
    status,
    type: "write",
  } satisfies ExecutionObservation;
}

export function describeExecutionStore(
  name: string,
  open: () => Promise<ExecutionStoreFixture>
): void {
  describe(name, () => {
    let fixture: ExecutionStoreFixture | undefined;
    const made: ExecutionStore[] = [];
    const store = async () => {
      fixture ??= await open();
      const executions = fixture.store();
      made.push(executions);
      return executions;
    };

    afterEach(async () => {
      for (const executions of made.splice(0)) {
        await executions.close().catch(() => undefined);
      }
      await fixture?.close();
      fixture = undefined;
    });

    it("keeps a run's observations in the order last written, and its latest progress", async () => {
      const executions = await store();
      await executions.observe("rn-a", effect("one", "running"), AT);
      await executions.observe("rn-a", effect("two"), AT);
      await executions.observe("rn-a", effect("one"), LATER);
      await executions.progress("rn-a", { step: 1 }, AT);
      await executions.progress("rn-a", { step: 2 }, LATER);
      expect(await executions.get("rn-a")).toEqual({
        id: "rn-a",
        observations: [effect("two"), effect("one")],
        progress: { step: 2 },
        revision: 5,
        updatedAt: LATER,
      });
      expect(await executions.get("rn-missing")).toBeUndefined();
    });

    it("removes runs and adds their removals to the retention gaps it holds", async () => {
      const executions = await store();
      await executions.progress("rn-a", { step: 1 }, AT);
      await executions.observe("rn-b", effect("one"), AT);
      const removal = { scope: "save", through: AT };
      expect(await executions.remove(["rn-a"], [removal], LATER)).toMatchObject(
        [{ removed: 1, scope: "save" }]
      );
      await executions.remove(
        ["rn-b"],
        [{ scope: "save", through: LATER }],
        LATER
      );
      expect(await executions.list()).toEqual([]);
      expect(await executions.gaps()).toEqual([
        { removed: 2, scope: "save", through: LATER, updatedAt: LATER },
      ]);
    });

    it("refuses what cannot be stored, and keeps nothing of it", async () => {
      const executions = await store();
      await expect(
        executions.progress("rn-a", { at: Number.NaN }, AT)
      ).rejects.toThrow();
      expect(await executions.get("rn-a")).toBeUndefined();
    });

    it("refuses every call once closed", async () => {
      const executions = await store();
      await executions.close();
      await expect(executions.list()).rejects.toThrow("closed");
    });
  });
}
