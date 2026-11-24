import { afterEach, describe, expect, it } from "vitest";
import type { RecordedScope } from "~/lib/run-scope";
import type { RunStore } from "~/lib/run-store";
import { ANY_STORED_RUN } from "~/lib/run-store";
import { NotStorableError } from "~/lib/state/json";
import type { RunRecord } from "~/lib/workflow-runs";
import { readRun } from "~/lib/workflow-runs";
import { putRun } from "./queue-runs";

export interface RunStoreFixture {
  close(): Promise<void>;
  store(): RunStore;
}

const SCOPE: RecordedScope = {
  ledger: { "flow|agents.session|0": { id: "s-1" } },
  literals: { flow: { n: 1 } },
  session: { id: "run-session" },
};

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

    it("keeps nothing of a commit that fails as it is filed", async () => {
      const runs = await store();
      const workflows = await runs.open((runId) =>
        runId === "rn-2" ? { ...SCOPE, ledger: { cost: Number.NaN } } : SCOPE
      );
      await putRun(workflows, "rn-1");
      await expect(putRun(workflows, "rn-2")).rejects.toThrow(NotStorableError);
      expect(await readRun(workflows, "rn-2")).toBeNull();
      expect(await runs.recorded("rn-2")).toEqual({ ledger: {} });
      expect((await runs.recorded("rn-1")).session).toBe("run-session");
    });

    it("claims a Run only while the Run as stored satisfies the claim's condition", async () => {
      const runs = await store();
      const workflows = await runs.open(() => undefined);
      await putRun(workflows, "rn-1", "suspended");
      await runs.release();
      const suspended = (stored: RunRecord | null) =>
        stored?.status === "suspended";

      await putRun(workflows, "rn-1", "running");
      await runs.release();
      expect(await runs.claim("rn-1", suspended)).toBe(false);
      expect(await runs.claim("rn-missing", suspended)).toBe(false);
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
        expect(await readRun(workflows, "rn-1")).toBeNull();
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

      expect(await readRun(workflows, "rn-1")).toBeNull();
      expect(await readRun(workflows, "rn-2")).not.toBeNull();
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
        await expect(readRun(workflows, "rn-1")).rejects.toThrow();
      }
    });

    it("waits, closing, for a call already under way", async () => {
      const runs = await store();
      const workflows = await runs.open(() => SCOPE);
      let landed = false;
      const putting = putRun(workflows, "rn-1").then(() => {
        landed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      await runs.close();
      expect(landed).toBe(true);
      await putting;
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
      "refuses, whole, a commit to a Run another store took over after this one let it go",
      async () => {
        const first = await store();
        const second = await store();
        const workflows = await first.open(() => SCOPE);
        await putRun(workflows, "rn-1", "suspended");
        await first.release("rn-1");
        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(true);

        await expect(putRun(workflows, "rn-1", "running")).rejects.toThrow(
          "is not held by this engine"
        );
        expect((await readRun(workflows, "rn-1"))?.status).toBe("suspended");
        expect(await first.claim("rn-1", ANY_STORED_RUN)).toBe(false);
      }
    );

    it.runIf(shared)(
      "refuses a change from the store that let a Run go, before any other claims it, until it claims it again",
      async () => {
        const first = await store();
        const second = await store();
        const workflows = await first.open(() => SCOPE);
        await putRun(workflows, "rn-1", "suspended");
        await first.release("rn-1");

        await expect(putRun(workflows, "rn-1", "running")).rejects.toThrow(
          "is not held by this engine"
        );
        expect((await readRun(workflows, "rn-1"))?.status).toBe("suspended");
        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(true);
        await second.release("rn-1");
        expect(await first.claim("rn-1", ANY_STORED_RUN)).toBe(true);
        await putRun(workflows, "rn-1", "running");
        expect((await readRun(workflows, "rn-1"))?.status).toBe("running");
      }
    );

    it.runIf(shared)(
      "lets one store own a Run at a time, until its owner gives it up or settles it",
      async () => {
        const first = await store();
        const second = await store();
        const workflows = await first.open(() => SCOPE);
        await putRun(workflows, "rn-1", "suspended");

        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(false);
        await first.release();
        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(true);
        expect(await first.claim("rn-1", ANY_STORED_RUN)).toBe(false);

        await second.release("rn-1");
        await putRun(workflows, "rn-1", "running");
        await putRun(workflows, "rn-1", "complete");
        expect(await second.claim("rn-1", ANY_STORED_RUN)).toBe(true);
      }
    );
  });
}
