import { describe, expect, test } from "vitest";
import type { RunEvent, RunEventType } from "../index";
import { ExecutionCoordinator } from "../index";
import { Orchestrator } from "../orchestrator";
import { RunEventSchema } from "../schema";
import { MemoryWorkflowStore } from "../store/memory";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";
import { FaultyWorkflowStore } from "./helpers/workflow-stores";

/** A coordinator over a store that records every write it commits. */
function recorded() {
  const store = new FaultyWorkflowStore(new MemoryWorkflowStore());
  return { coordinator: new ExecutionCoordinator({ store }), store };
}

/** The events of every write committed after `from`, in commit order. */
function eventsSince(store: FaultyWorkflowStore, from = 0): RunEvent[] {
  return store.commits.slice(from).flatMap((write) => write.events ?? []);
}

function types(events: readonly RunEvent[]): RunEventType[] {
  return events.map((event) => event.type);
}

const RUN = { input: null, queueId: "q", step: "s" } as const;

const PARK = {
  kind: "approval",
  name: "approve",
  reason: "needs a human",
  request: null,
  stepPath: ["s"],
} as const;

describe("ExecutionCoordinator change events", () => {
  test("a Run filed carries run.queued in the write that files it", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun({ ...RUN, id: "rn-a" });

    expect(store.commits).toHaveLength(1);
    const [write] = store.commits;
    expect(write?.putRuns?.[0]?.id).toBe(run.id);
    const [event] = write?.events ?? [];
    expect(event).toStrictEqual({
      at: expect.any(String),
      id: expect.any(String),
      queueId: "q",
      runId: "rn-a",
      type: "run.queued",
    });
    expect(RunEventSchema.parse(event)).toStrictEqual(event);
    expect(new Date(event?.at ?? "").toISOString()).toBe(event?.at);
  });

  test("a Run abandoned after a crash carries run.failed once, and a settled one nothing", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    await coordinator.updateRun(run.id, { status: "running" });
    const from = store.commits.length;
    const crashed = { message: "its process exited", name: "Interrupted" };

    await coordinator.abandonRun(run.id, crashed, 7);
    await coordinator.abandonRun(run.id, crashed, 8);

    expect(store.commits).toHaveLength(from + 1);
    expect(types(eventsSince(store, from))).toEqual([
      "run.failed",
      "run.updated",
    ]);
    expect(eventsSince(store, from)[1]).toMatchObject({ changed: ["error"] });
  });

  test("each lifecycle change of a Run makes its own event, in order", async () => {
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

    const events = eventsSince(store);
    expect(types(events)).toStrictEqual([
      "run.queued",
      "run.started",
      "run.parked",
      "run.resumed",
      "run.started",
      "run.completed",
    ]);
    expect(events.every((event) => event.runId === run.id)).toBe(true);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });

  test("a running Run patched back to queued says run.resumed", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    await coordinator.updateRun(run.id, { status: "running" });
    const from = store.commits.length;

    await coordinator.updateRun(run.id, { status: "queued" });

    expect(types(eventsSince(store, from))).toStrictEqual(["run.resumed"]);
  });

  test("a change to a Run's own data says run.updated, naming the fields, not their values", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    await coordinator.updateRun(run.id, { status: "running" });
    const from = store.commits.length;

    await coordinator.updateRun(run.id, { tags: { customer: "new" } });
    await coordinator.updateRun(run.id, {
      error: { message: "slow", name: "Warning" },
      extensions: { "host.flag": { on: true } },
      output: { large: "x".repeat(1000) },
    });
    await coordinator.updateRun(run.id, { metadata: { owner: "ops" } });
    await coordinator.updateRun(run.id, { timestamps: { startedAt: 5 } });

    const events = eventsSince(store, from);
    expect(
      events.map((event) => event.type === "run.updated" && event.changed)
    ).toStrictEqual([
      ["tags"],
      ["error", "extensions", "output"],
      ["metadata"],
      ["timestamps"],
    ]);
    expect(events[0]).toStrictEqual({
      at: expect.any(String),
      changed: ["tags"],
      id: expect.any(String),
      queueId: "q",
      runId: run.id,
      type: "run.updated",
    });
    expect(JSON.stringify(events)).not.toContain("xxxx");
    for (const event of events) {
      expect(RunEventSchema.parse(event)).toStrictEqual(event);
    }
  });

  test("a status change with Run data beside it says both, the lifecycle first; its own timestamps are part of it", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    const from = store.commits.length;

    await coordinator.updateRun(run.id, {
      status: "running",
      timestamps: { startedAt: 1 },
    });
    await coordinator.updateRun(run.id, {
      output: "done",
      status: "complete",
      tags: { result: "ok" },
      timestamps: { completedAt: 2 },
    });

    expect(
      store.commits
        .slice(from)
        .map((write) =>
          (write.events ?? []).map((event) =>
            event.type === "run.updated" ? event.changed : event.type
          )
        )
    ).toStrictEqual([["run.started"], ["run.completed", ["output", "tags"]]]);
  });

  test("a change that leaves every record as stored writes nothing", async () => {
    const { coordinator, store } = recorded();
    await coordinator.ensureQueue({ id: "q", name: "Q" });
    await coordinator.updateQueue("q", { status: "paused" });
    const job = await coordinator.createJob({
      definition: { name: "d" },
      input: null,
    });
    const run = await coordinator.createRun(RUN);
    await coordinator.cancelRun(run.id);
    const from = store.commits.length;

    await coordinator.updateQueue("q", { status: "paused" });
    await coordinator.updateJob(job.id, { status: "pending" });
    await coordinator.cancelRunSuspensions(run.id);
    await coordinator.updateRun(run.id, { tags: {} });
    await coordinator.deleteRun("rn-missing");
    await coordinator.deleteJob("jb-missing");
    await coordinator.deleteSuspension("su-missing");
    await coordinator.deleteRunFrames(run.id);

    expect(store.commits.slice(from)).toStrictEqual([]);
  });

  test("a patch that changes no Run-level data says nothing: a true no-op writes nothing, step progress writes without an event", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun({
      ...RUN,
      metadata: { workflow: { status: "queued" } },
      tags: { customer: "a" },
    });
    await coordinator.updateRun(run.id, { status: "running" });
    const from = store.commits.length;

    await coordinator.updateRun(run.id, { status: "running" });
    await coordinator.updateRun(run.id, { tags: { customer: "a" } });
    await coordinator.updateRun(run.id, {
      snapshot: { cursor: null, input: null, name: "s", steps: [] },
    });
    await coordinator.updateRun(run.id, {
      metadata: { stream: [], workflow: { status: "running" } },
    });

    // The same status and the same tags leave the Run as stored: no write.
    // The step tree and the runtime's metadata are written, with no event.
    expect(store.commits.length).toBe(from + 2);
    for (const write of store.commits.slice(from)) {
      expect(write).not.toHaveProperty("events");
    }
  });

  test("a persist that drops a host's metadata says so", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun({
      ...RUN,
      metadata: { owner: "ops" },
    });
    const from = store.commits.length;

    // A metadata patch replaces the host's namespaces with what it holds.
    await coordinator.updateRun(run.id, { metadata: { workflow: {} } });

    expect(
      eventsSince(store, from).map(
        (event) => event.type === "run.updated" && event.changed
      )
    ).toStrictEqual([["metadata"]]);
  });

  test("a Run that fails or is cancelled says so", async () => {
    const { coordinator, store } = recorded();
    const failing = await coordinator.createRun(RUN);
    await coordinator.updateRun(failing.id, { status: "failed" });
    const cancelled = await coordinator.createRun(RUN);
    await coordinator.cancelRun(cancelled.id);

    expect(
      eventsSince(store).map((event) => [event.type, event.runId])
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

    expect(eventsSince(store, from)).toStrictEqual([]);
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
    expect(types(eventsSince(store, from))).toStrictEqual(["run.cancelled"]);
  });

  test("parking a Run already parked, at another Suspension, says nothing more", async () => {
    const { coordinator, store } = recorded();
    const run = await coordinator.createRun(RUN);
    await coordinator.parkSuspension({ ...PARK, runId: run.id });
    const from = store.commits.length;

    await coordinator.parkSuspension({ ...PARK, name: "again", runId: run.id });

    expect(store.commits.length).toBe(from + 1);
    expect(eventsSince(store, from)).toStrictEqual([]);
  });

  test("a Job's managed attempt is filed, and cancelled with its Job, with events", async () => {
    const { coordinator, store } = recorded();
    const job = await coordinator.createJob({
      definition: { name: "d" },
      input: null,
    });
    const { run } = await coordinator.claimJobRun(job.id, RUN);
    await coordinator.cancelJob(job.id);

    // Job changes alone carry no events: only the claim and the cancellation do.
    expect(
      store.commits.map((write) => types(write.events ?? []))
    ).toStrictEqual([[], ["run.queued"], ["run.cancelled"]]);
    expect(eventsSince(store).every((event) => event.runId === run.id)).toBe(
      true
    );
  });

  test("a Run deleted says run.removed with what identified it; a delete of no Run writes nothing", async () => {
    const { coordinator, store } = recorded();
    const job = await coordinator.createJob({
      definition: { name: "d" },
      input: null,
    });
    const { run } = await coordinator.claimJobRun(job.id, {
      ...RUN,
      definition: { name: "documents.generate", version: "2" },
      links: { sessionId: "ss-1" },
      tags: { customer: "a" },
    });
    await coordinator.updateRun(run.id, { status: "complete" });
    const from = store.commits.length;

    await coordinator.deleteRun(run.id);
    await coordinator.deleteRun("rn-missing");

    expect(
      store.commits.slice(from).map((write) => write.events)
    ).toStrictEqual([
      [
        {
          at: expect.any(String),
          definition: { name: "documents.generate", version: "2" },
          id: expect.any(String),
          links: { jobId: job.id, sessionId: "ss-1" },
          queueId: "q",
          runId: run.id,
          step: "s",
          tags: { customer: "a" },
          type: "run.removed",
        },
      ],
    ]);
    const [removed] = eventsSince(store, from);
    expect(RunEventSchema.parse(removed)).toStrictEqual(removed);
  });

  test("a snapshot restored carries no events", async () => {
    const source = new ExecutionCoordinator();
    await source.ensureQueue({ id: "q", name: "Q" });
    await source.createRun(RUN);
    const { coordinator, store } = recorded();

    await coordinator.restore(await source.snapshot());

    expect(store.commits).toHaveLength(1);
    expect(store.commits[0]).not.toHaveProperty("events");
  });

  test("a commit the store refuses takes its events with it", async () => {
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
    const started = eventsSince(store).filter(
      (event) => event.type === "run.started"
    );
    expect(started).toHaveLength(1);
    expect((await coordinator.getRun(run.id))?.status).toBe("running");
  });
});

describe("Run events of a Run the Orchestrator drives", () => {
  /** An Orchestrator over a recording store, with one workflow of one step. */
  async function driven() {
    const { coordinator, store } = recorded();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: coordinator,
    });
    orchestrator.register("w", async () =>
      Workflow.create({
        children: [
          { execute: async () => "leaf", input: undefined, name: "leaf" },
        ],
        execute: async (_input, context) => {
          await context.children[0]?.run();
          return "ok";
        },
        input: undefined,
        name: "w",
      })
    );
    await orchestrator.setup();
    return { coordinator, orchestrator, store };
  }

  /** Each write naming `runId`: the status it stores, and the events it carries. */
  function writesOf(store: FaultyWorkflowStore, runId: string) {
    return store.commits
      .filter((write) => write.putRuns?.some((run) => run.id === runId))
      .map((write) => ({
        events: (write.events ?? []).map((event) =>
          event.type === "run.updated" ? event.changed : event.type
        ),
        status: write.putRuns?.find((run) => run.id === runId)?.status,
      }));
  }

  test("a Run started stays running until it ends: no step's state sends it back to queued", async () => {
    const { orchestrator, store } = await driven();
    await orchestrator.start();
    const job = await orchestrator.createJob("w", null);
    const run = await orchestrator.execute(job.id);
    await run.result();
    await orchestrator.stop({ graceMs: 1 });

    const writes = writesOf(store, run.id);
    expect(writes.map((write) => write.status)).not.toContain(undefined);
    const statuses = writes.map((write) => write.status);
    expect(statuses.slice(statuses.indexOf("running"))).not.toContain("queued");
    expect(writes.flatMap((write) => write.events)).toStrictEqual([
      "run.queued",
      "run.started",
      "run.completed",
      ["output"],
    ]);
  });

  test("a Run parked and resumed says so, keeps the time it first started, and ends", async () => {
    const { coordinator, orchestrator, store } = await driven();
    orchestrator.register("ask", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend<string>({
            kind: "approval",
            name: "approval",
            reason: "needs a human",
            request: null,
          }),
        input,
        name: "ask",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("ask", null);
    let pending: { readonly id: string } | undefined;
    for (let tries = 0; pending === undefined && tries < 400; tries += 1) {
      [pending] = (
        await orchestrator.listSuspensions({ runId: run.id, status: "pending" })
      ).items;
      if (pending === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const startedAt = (await coordinator.getRun(run.id))?.timestamps.startedAt;
    await orchestrator.resolve(pending?.id ?? "", "yes");
    await run.result();
    await orchestrator.stop({ graceMs: 1 });

    expect(
      writesOf(store, run.id).flatMap((write) => write.events)
    ).toStrictEqual([
      "run.queued",
      "run.started",
      "run.parked",
      "run.resumed",
      "run.started",
      "run.completed",
      ["output"],
    ]);
    expect(typeof startedAt).toBe("number");
    expect((await coordinator.getRun(run.id))?.timestamps.startedAt).toBe(
      startedAt
    );
  });

  test("a Run that fails says so once, naming its error once", async () => {
    const { orchestrator, store } = await driven();
    orchestrator.register("boom", (input: null) =>
      Workflow.create({
        children: [
          { execute: async () => "leaf", input: undefined, name: "leaf" },
        ],
        execute: async (_value, context) => {
          await context.children[0]?.run();
          throw new Error("boom");
        },
        input,
        name: "boom",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("boom", null);
    await run.result().catch(() => undefined);
    await orchestrator.stop({ graceMs: 1 });

    expect(
      writesOf(store, run.id).flatMap((write) => write.events)
    ).toStrictEqual(["run.queued", "run.started", "run.failed", ["error"]]);
  });

  test("a Run recovered while running is not resumed: it goes on running", async () => {
    const { coordinator, orchestrator, store } = await driven();
    const [queue] = await coordinator.listQueues();
    const run = await coordinator.createRun({
      definition: { name: "w" },
      input: null,
      queueId: queue?.id ?? "",
      step: "w",
    });
    await coordinator.updateRun(run.id, {
      status: "running",
      timestamps: { startedAt: 1 },
    });
    const from = store.commits.length;

    await orchestrator.start();
    await (await orchestrator.get(run.id))?.result();
    await orchestrator.stop({ graceMs: 1 });

    const events = eventsSince(store, from)
      .filter((event) => event.runId === run.id)
      .map((event) => event.type);
    expect(events).not.toContain("run.resumed");
    expect(events).toContain("run.completed");
  });
});
