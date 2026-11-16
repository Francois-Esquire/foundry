import { ExecutionCoordinator } from "@foundry/workflows";
import type { RunRecord } from "@foundry/workflows/schema";
import type { WorkflowStore } from "@foundry/workflows/store";
import { afterEach, describe, expect, it } from "vitest";
import type { RecordedScope } from "~/lib/run-scope";
import type { RunStore } from "~/lib/run-store";
import { ANY_STORED_RUN } from "~/lib/run-store";
import { NotStorableError } from "~/lib/state/json";

/**
 * Where a run store under test comes from: `store()` makes another over
 * the same records, as a second engine would have. `close` ends whatever
 * the stores were made over.
 */
export interface RunStoreFixture {
  close(): Promise<void>;
  store(): RunStore;
}

const SCOPE: RecordedScope = {
  ledger: { "flow|agents.session|0": { id: "s-1" } },
  literals: { flow: { n: 1 } },
  session: { id: "run-session" },
};

/** A Run put through `workflows`, as an Orchestrator would put it. */
export async function putRun(
  workflows: WorkflowStore,
  id: string,
  status?: "complete" | "running" | "suspended"
): Promise<void> {
  const coordinator = new ExecutionCoordinator({ store: workflows });
  const [queue] = await coordinator.listQueues();
  const queueId =
    queue?.id ??
    (await coordinator.ensureQueue({ id: "qu-1", name: "marbles" })).id;
  if ((await coordinator.getRun(id)) === null) {
    await coordinator.createRun({ id, input: null, queueId, step: "flow" });
  }
  if (status !== undefined) {
    if (status === "complete") {
      await coordinator.updateRun(id, { status: "running" });
    }
    await coordinator.updateRun(id, { status });
  }
}

/**
 * The contract every `RunStore` keeps, whatever it keeps Runs in. `shared`
 * says whether two stores from one fixture see one another's Runs, as two
 * engines over one database do, or each keeps its own, as in memory.
 */
export function describeRunStore(
  name: string,
  open: () => Promise<RunStoreFixture>,
  { shared }: { readonly shared: boolean }
): void {
  describe(name, () => {
    let fixture: RunStoreFixture | undefined;
    const made: RunStore[] = [];
    const store = async () => {
      fixture ??= await open();
      const runs = fixture.store();
      made.push(runs);
      return runs;
    };

    afterEach(async () => {
      for (const runs of made.splice(0)) {
        await runs.close().catch(() => undefined);
      }
      await fixture?.close();
      fixture = undefined;
    });

    it("files what a Run's scope recorded in the commit that puts it, and only for Runs it records", async () => {
      const runs = await store();
      const workflows = await runs.open((runId) =>
        runId === "rn-held" ? SCOPE : undefined
      );
      await putRun(workflows, "rn-held");
      await putRun(workflows, "rn-other");

      expect(await runs.recorded("rn-held")).toEqual({
        ledger: SCOPE.ledger,
        literals: SCOPE.literals,
        session: "run-session",
      });
      expect(await runs.recorded("rn-other")).toEqual({ ledger: {} });
      expect(await runs.recorded("rn-unknown")).toEqual({ ledger: {} });
    });

    it("gives back a recording its caller can change without changing what is kept", async () => {
      const runs = await store();
      const workflows = await runs.open(() => SCOPE);
      await putRun(workflows, "rn-1");

      const first = await runs.recorded("rn-1");
      (first.ledger["flow|agents.session|0"] as { id: string }).id = "changed";
      (first.literals?.flow as Record<string, unknown>).n = 2;

      expect(await runs.recorded("rn-1")).toEqual({
        ledger: SCOPE.ledger,
        literals: SCOPE.literals,
        session: "run-session",
      });
    });

    it("keeps nothing of a commit a transaction rolls back", async () => {
      const runs = await store();
      const workflows = await runs.open(() => SCOPE);
      await expect(
        workflows.transaction?.(async (view) => {
          await putRun(view, "rn-1");
          throw new Error("rolled back");
        })
      ).rejects.toThrow("rolled back");
      expect(await workflows.getRun("rn-1")).toBeNull();
      expect(await runs.recorded("rn-1")).toEqual({ ledger: {} });
    });

    it("claims a Run only while the Run as stored satisfies the claim's condition", async () => {
      const runs = await store();
      const workflows = await runs.open(() => undefined);
      await putRun(workflows, "rn-1", "suspended");
      await runs.release();
      const parked = (stored: RunRecord | null) =>
        stored?.status === "suspended";

      // Moved on before the claim: the claim decides on what is stored now.
      await putRun(workflows, "rn-1", "running");
      await runs.release();
      expect(await runs.claim("rn-1", parked)).toBe(false);
      expect(await runs.claim("rn-missing", parked)).toBe(false);
      const seen: (string | null)[] = [];
      expect(
        await runs.claim("rn-1", (stored) => {
          seen.push(stored?.status ?? null);
          return true;
        })
      ).toBe(true);
      expect(seen).toEqual(["running"]);
    });

    it("refuses, whole, a commit whose recording JSON would not give back as it is", async () => {
      for (const [ledger, literals] of [
        [{ cost: Number.NaN }, {}],
        [{ at: new Date(0) }, {}],
        [{}, { flow: { list: [1, undefined] } }],
        [{}, { flow: { n: Number.POSITIVE_INFINITY } }],
      ] as const) {
        const runs = await store();
        const workflows = await runs.open(() => ({
          ledger: ledger as Record<string, unknown>,
          literals: literals as Record<string, Record<string, unknown>>,
          session: { id: "run-session" },
        }));
        await expect(putRun(workflows, "rn-1")).rejects.toThrow(
          NotStorableError
        );
        expect(await workflows.getRun("rn-1")).toBeNull();
        expect(await runs.recorded("rn-1")).toEqual({ ledger: {} });
      }
    });

    it("keeps a recording in the form JSON gives back: -0 as 0, a property holding undefined left out", async () => {
      const runs = await store();
      const workflows = await runs.open(() => ({
        ledger: { entry: { n: -0 } },
        literals: { flow: { n: -0, optional: undefined } },
        session: { id: "run-session" },
      }));
      await putRun(workflows, "rn-1");
      const recorded = await runs.recorded("rn-1");
      expect(recorded).toEqual({
        ledger: { entry: { n: 0 } },
        literals: { flow: { n: 0 } },
        session: "run-session",
      });
      expect(Object.is(recorded.literals?.flow?.n, 0)).toBe(true);
      expect(Object.hasOwn(recorded.literals?.flow ?? {}, "optional")).toBe(
        false
      );
    });

    it("claims a Run for itself, and gives it up when told", async () => {
      const runs = await store();
      expect(await runs.claim("rn-1", ANY_STORED_RUN)).toBe(true);
      expect(await runs.claim("rn-1", ANY_STORED_RUN)).toBe(true);
      await runs.release("rn-1");
      expect(await runs.claim("rn-1", ANY_STORED_RUN)).toBe(true);
      await runs.release();
    });

    it("removes a Run and what was recorded beside it in one write", async () => {
      const runs = await store();
      const workflows = await runs.open(() => SCOPE);
      await putRun(workflows, "rn-1", "complete");
      await putRun(workflows, "rn-2", "complete");

      await runs.remove("rn-1");
      await runs.remove("rn-unknown");

      expect(await workflows.getRun("rn-1")).toBeNull();
      expect(await workflows.getRun("rn-2")).not.toBeNull();
      expect(await runs.recorded("rn-1")).toEqual({ ledger: {} });
      expect((await runs.recorded("rn-2")).session).toBe("run-session");
    });

    it("refuses every call once closed, the workflow records' too", async () => {
      const runs = await store();
      const workflows = await runs.open(() => undefined);
      await runs.close();
      await expect(runs.claim("rn-1", ANY_STORED_RUN)).rejects.toThrow();
      await expect(runs.recorded("rn-1")).rejects.toThrow();
      if (runs.durable) {
        await expect(workflows.getRun("rn-1")).rejects.toThrow();
      }
    });

    it("waits, closing, for a call already under way", async () => {
      const runs = await store();
      const workflows = await runs.open(() => SCOPE);
      let landed = false;
      const putting = workflows
        .transaction?.((view) => putRun(view, "rn-1"))
        .then(() => {
          landed = true;
        });
      await runs.close();
      // Closed only once it was done: the host may close what it is over.
      expect(landed).toBe(true);
      await putting;
      // It landed whole: the next store over the same records reads it.
      if (shared) {
        const next = await store();
        expect((await next.recorded("rn-1")).session).toBe("run-session");
      }
    });

    it.runIf(shared)(
      "owns every Run it puts unsettled, one its engine recorded nothing for too",
      async () => {
        const first = await store();
        const second = await store();
        const workflows = await first.open(() => undefined);
        await putRun(workflows, "rn-1", "running");

        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(false);
        await putRun(workflows, "rn-1", "complete");
        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(true);
      }
    );

    it.runIf(shared)(
      "lets one store own a Run at a time, until its owner gives it up or settles it",
      async () => {
        const first = await store();
        const second = await store();
        const workflows = await first.open(() => SCOPE);
        await putRun(workflows, "rn-1", "suspended");

        // Putting it made the first its owner; the second is refused.
        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(false);
        await first.release();
        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(true);
        expect(await first.claim("rn-1", ANY_STORED_RUN)).toBe(false);

        await second.release("rn-1");
        await putRun(workflows, "rn-1", "running");
        await putRun(workflows, "rn-1", "complete");
        // Settled: no store owns it.
        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(true);
      }
    );
  });
}
