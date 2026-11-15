import { describe, expect, test } from "vitest";
import type { RunFact, RunFactType } from "../index";
import { ExecutionCoordinator } from "../index";
import { RunFactSchema } from "../schema";
import { MemoryWorkflowStore } from "../store/memory";
import { FaultyWorkflowStore } from "./helpers/workflow-stores";

/** A coordinator over a store that records every write it commits. */
function recorded() {
  const store = new FaultyWorkflowStore(new MemoryWorkflowStore());
  return { coordinator: new ExecutionCoordinator({ store }), store };
}

/** The facts of every write committed after `from`, in commit order. */
function factsSince(store: FaultyWorkflowStore, from = 0): RunFact[] {
  return store.commits.slice(from).flatMap((write) => write.facts ?? []);
}

function types(facts: readonly RunFact[]): RunFactType[] {
  return facts.map((fact) => fact.type);
}

const RUN = { input: null, queueId: "q", step: "s" } as const;

const PARK = {
  kind: "approval",
  name: "approve",
  reason: "needs a human",
  request: null,
  stepPath: ["s"],
} as const;

describe("ExecutionCoordinator change facts", () => {
  test("a Run filed carries run.queued in the write that files it", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun({ ...RUN, id: "rn-a" });

    expect(store.commits).toHaveLength(1);
    const [write] = store.commits;
    expect(write?.putRuns?.[0]?.id).toBe(run.id);
    const [fact] = write?.facts ?? [];
    expect(fact).toStrictEqual({
      at: expect.any(String),
      id: expect.any(String),
      queueId: "q",
      runId: "rn-a",
      type: "run.queued",
    });
    expect(RunFactSchema.parse(fact)).toStrictEqual(fact);
    expect(new Date(fact?.at ?? "").toISOString()).toBe(fact?.at);
  });

  test("each lifecycle change of a Run makes its own fact, in order", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    await coordinator.updateRun(run.id, { status: "running" });
    await coordinator.parkSuspension({ ...PARK, runId: run.id });
    const [suspension] = (await coordinator.listSuspensions({ runId: run.id }))
      .items;
    await coordinator.settleSuspension(suspension?.id ?? "", {
      expectedRevision: 0,
      outcome: { resolution: "yes", status: "resolved" },
    });
    await coordinator.updateRun(run.id, { status: "running" });
    await coordinator.updateRun(run.id, { status: "complete" });

    const facts = factsSince(store);
    expect(types(facts)).toStrictEqual([
      "run.queued",
      "run.started",
      "run.parked",
      "run.resumed",
      "run.started",
      "run.completed",
    ]);
    expect(facts.every((fact) => fact.runId === run.id)).toBe(true);
    expect(new Set(facts.map((fact) => fact.id)).size).toBe(facts.length);
  });

  test("a patch that leaves the status as it was carries no facts", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    await coordinator.updateRun(run.id, { status: "running" });
    const from = store.commits.length;

    await coordinator.updateRun(run.id, {
      output: { partial: true },
      status: "running",
      tags: { step: "two" },
    });
    await coordinator.updateRun(run.id, { output: { partial: false } });

    expect(store.commits.length).toBe(from + 2);
    for (const write of store.commits.slice(from)) {
      expect(write).not.toHaveProperty("facts");
    }
  });

  test("a Run that fails or is cancelled says so", async () => {
    const { coordinator, store } = recorded();
    const failing = await coordinator.createRun(RUN);
    await coordinator.updateRun(failing.id, { status: "failed" });
    const cancelled = await coordinator.createRun(RUN);
    await coordinator.cancelRun(cancelled.id);

    expect(
      factsSince(store).map((fact) => [fact.type, fact.runId])
    ).toStrictEqual([
      ["run.queued", failing.id],
      ["run.failed", failing.id],
      ["run.queued", cancelled.id],
      ["run.cancelled", cancelled.id],
    ]);
  });

  test("cancelling an ended Run again, or patching it to another status, says nothing", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    await coordinator.cancelRun(run.id);
    const from = store.commits.length;

    await coordinator.cancelRunSuspensions(run.id);
    await coordinator.updateRun(run.id, { status: "running" });

    expect(factsSince(store, from)).toStrictEqual([]);
  });

  test("a Suspension cancelled cancels its parked Run in one write", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    const { suspension } = await coordinator.parkSuspension({
      ...PARK,
      runId: run.id,
    });
    const from = store.commits.length;

    await coordinator.settleSuspension(suspension.id, {
      expectedRevision: 0,
      outcome: { status: "cancelled" },
    });

    expect(store.commits.slice(from)).toHaveLength(1);
    expect(types(factsSince(store, from))).toStrictEqual(["run.cancelled"]);
  });

  test("parking a Run already parked, at another Suspension, says nothing more", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    await coordinator.parkSuspension({ ...PARK, runId: run.id });
    const from = store.commits.length;

    await coordinator.parkSuspension({ ...PARK, name: "again", runId: run.id });

    expect(store.commits.length).toBe(from + 1);
    expect(factsSince(store, from)).toStrictEqual([]);
  });

  test("a Job's managed attempt is filed, and cancelled with its Job, with facts", async () => {
    const { coordinator, store } = recorded();
    const job = await coordinator.createJob({
      definition: { name: "d" },
      input: null,
    });
    const { run } = await coordinator.claimJobRun(job.id, RUN);
    await coordinator.cancelJob(job.id);

    // Job changes alone carry no facts: only the claim and the cancellation do.
    expect(
      store.commits.map((write) => types(write.facts ?? []))
    ).toStrictEqual([[], ["run.queued"], ["run.cancelled"]]);
    expect(factsSince(store).every((fact) => fact.runId === run.id)).toBe(true);
  });

  test("a Run deleted says run.removed; a delete of no Run says nothing", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    const from = store.commits.length;

    await coordinator.deleteRun(run.id);
    await coordinator.deleteRun("rn-missing");

    expect(store.commits.slice(from).map((write) => write.facts)).toStrictEqual(
      [
        [
          {
            at: expect.any(String),
            id: expect.any(String),
            queueId: "q",
            runId: run.id,
            type: "run.removed",
          },
        ],
        undefined,
      ]
    );
  });

  test("a snapshot restored carries no facts", async () => {
    const source = new ExecutionCoordinator();
    await source.ensureQueue({ id: "q", name: "Q" });
    await source.createRun(RUN);
    const { coordinator, store } = recorded();

    await coordinator.restore(await source.snapshot());

    expect(store.commits).toHaveLength(1);
    expect(store.commits[0]).not.toHaveProperty("facts");
  });

  test("a commit the store refuses takes its facts with it", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    store.before = () => {
      throw new Error("refused");
    };

    await expect(
      coordinator.updateRun(run.id, { status: "running" })
    ).rejects.toThrow("refused");

    store.before = () => undefined;
    await coordinator.updateRun(run.id, { status: "running" });
    const started = factsSince(store).filter(
      (fact) => fact.type === "run.started"
    );
    expect(started).toHaveLength(1);
    expect((await coordinator.getRun(run.id))?.status).toBe("running");
  });
});
