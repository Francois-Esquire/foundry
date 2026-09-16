import { describe, expect, test } from "vitest";
import { RunNotFoundError, RunReplayGapError } from "../errors";
import { Orchestrator } from "../orchestrator";
import type { RunObservation } from "../run-observation";
import {
  RUN_FRAME_RETENTION_POLICY,
  RunObservationJournal,
} from "../run-observation";
import type { RunFrame } from "../store";
import { InMemoryOrchestratorStore } from "../store";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";
import { makeInMemoryStore } from "./helpers/store";

class DelayedFrameStore extends InMemoryOrchestratorStore {
  readonly frameWriteEntered: Promise<void>;
  #announceFrameWrite: () => void = () => undefined;
  #releaseFrameWrite: () => void = () => undefined;
  readonly #frameWriteGate: Promise<void>;

  constructor() {
    super();
    this.frameWriteEntered = new Promise((resolve) => {
      this.#announceFrameWrite = resolve;
    });
    this.#frameWriteGate = new Promise((resolve) => {
      this.#releaseFrameWrite = resolve;
    });
  }

  releaseFrameWrite(): void {
    this.#releaseFrameWrite();
  }

  protected override async writeFrame(frame: RunFrame): Promise<void> {
    this.#announceFrameWrite();
    await this.#frameWriteGate;
    await super.writeFrame(frame);
  }
}

async function collect(observation: RunObservation): Promise<RunFrame[]> {
  const frames: RunFrame[] = [];
  for await (const frame of observation) {
    frames.push(frame);
  }
  return frames;
}

async function seedRun(runId: string) {
  const store = makeInMemoryStore();
  const queue = await store.ensureQueue({ id: "qu-observe", name: "observe" });
  await store.createRun({
    definition: { name: "observe" },
    id: runId,
    input: null,
    queueId: queue.id,
    step: "observe",
  });
  return store;
}

describe("RunObservationJournal", () => {
  test("atomically claims one Run effect across concurrent journals and snapshot recovery", async () => {
    const runId = "rn-effect-claim";
    const store = await seedRun(runId);
    const firstProcess = new RunObservationJournal(store);
    const competingProcess = new RunObservationJournal(store);

    await firstProcess.publish(runId, {
      kind: "output",
      value: { phase: "before" },
    });
    const concurrentClaims = await Promise.all([
      firstProcess.claimEffect(runId, "model-segment-0", {
        definition: "documents.agent-turn",
      }),
      competingProcess.claimEffect(runId, "model-segment-0"),
    ]);
    expect([...concurrentClaims].sort()).toEqual([false, true]);

    const recoveredStore = new InMemoryOrchestratorStore({
      snapshot: store.snapshot(),
    });
    const recoveredProcess = new RunObservationJournal(recoveredStore);
    await expect(
      recoveredProcess.claimEffect(runId, "model-segment-0")
    ).resolves.toBe(false);
    await recoveredProcess.publish(runId, {
      kind: "output",
      value: { phase: "after" },
    });

    const frames = await recoveredStore.listRunFrames(runId);
    expect(frames.map((frame) => frame.cursor)).toEqual([0, 1, 2]);
    expect(frames.map((frame) => frame.payload)).toEqual([
      { kind: "output", value: { phase: "before" } },
      {
        kind: "log",
        value: {
          event: "run-effect-claimed",
          key: "model-segment-0",
          metadata: { definition: "documents.agent-turn" },
        },
      },
      { kind: "output", value: { phase: "after" } },
    ]);
  });

  test("keeps delivery pending until the frame append is durable", async () => {
    const runId = "rn-record-before-notify";
    const store = await seedRun(runId);
    const appendFrame = store.appendRunFrame.bind(store);
    let releaseAppend: () => void = () => undefined;
    let announceAppend: () => void = () => undefined;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendEntered = new Promise<void>((resolve) => {
      announceAppend = resolve;
    });
    store.appendRunFrame = async (input) => {
      announceAppend();
      await appendGate;
      return appendFrame(input);
    };
    const journal = new RunObservationJournal(store);
    const observation = await journal.observe(runId);
    let delivered = false;
    const next = observation[Symbol.asyncIterator]()
      .next()
      .then((result) => {
        delivered = true;
        return result;
      });
    const publishing = journal.publish(runId, {
      kind: "output",
      value: "durable-first",
    });

    await appendEntered;
    expect(delivered).toBe(false);
    await expect(store.listRunFrames(runId)).resolves.toEqual([]);
    releaseAppend();
    await publishing;
    await expect(next).resolves.toMatchObject({
      value: { payload: { kind: "output", value: "durable-first" } },
    });
    observation.close();
  });

  test("atomically hands replay into live delivery without gaps or duplicates", async () => {
    const runId = "rn-replay-live";
    const store = await seedRun(runId);
    const journal = new RunObservationJournal(store);
    await journal.publish(runId, { kind: "output", value: "before" });

    const observing = journal.observe(runId);
    const publishing = journal.publish(runId, {
      kind: "output",
      value: "during",
    });
    const observation = await observing;
    await publishing;
    const first = await observation[Symbol.asyncIterator]().next();
    const second = await observation[Symbol.asyncIterator]().next();
    observation.close();

    expect([first.value, second.value]).toMatchObject([
      { cursor: 0, payload: { kind: "output", value: "before" } },
      { cursor: 1, payload: { kind: "output", value: "during" } },
    ]);
  });

  test("persists before notifying and isolates fast observers from slow ones", async () => {
    const runId = "rn-observer-isolation";
    const store = await seedRun(runId);
    const journal = new RunObservationJournal(store);
    const fast = await journal.observe(runId);
    const slow = await journal.observe(runId);
    const fastFrames = collect(fast);
    const suspension = await store.createSuspension({
      id: "su-observer-isolation",
      kind: "permission",
      name: "approval",
      reason: "test",
      request: { capability: "write" },
      runId,
      stepPath: ["observe"],
    });

    await journal.publish(runId, { kind: "output", value: { delta: "a" } });
    await journal.publish(runId, { kind: "progress", value: 0.5 });
    await journal.publish(runId, {
      kind: "log",
      value: { level: "info", message: "halfway" },
    });
    await journal.publish(runId, { kind: "suspension", value: suspension });
    const terminal = await journal.publish(runId, {
      kind: "lifecycle",
      value: { event: "complete", status: "complete" },
    });

    const persisted = await store.listRunFrames(runId);
    expect(persisted.at(-1)).toEqual(terminal);
    await expect(fastFrames).resolves.toHaveLength(5);
    await expect(collect(slow)).resolves.toHaveLength(5);
    expect(persisted.map((frame) => frame.cursor)).toEqual([0, 1, 2, 3, 4]);
    expect(RUN_FRAME_RETENTION_POLICY).toBe("retain-all-proof");
  });

  test("detach removes only that observer", async () => {
    const runId = "rn-detach-one";
    const store = await seedRun(runId);
    const journal = new RunObservationJournal(store);
    const detached = await journal.observe(runId);
    const remaining = await journal.observe(runId);
    detached.close();

    await journal.publish(runId, { kind: "output", value: "still-running" });
    const next = await remaining[Symbol.asyncIterator]().next();
    remaining.close();
    expect(next.value).toMatchObject({
      payload: { kind: "output", value: "still-running" },
    });
  });

  test("returns typed missing-Run and future retention-gap errors", async () => {
    const runId = "rn-replay-gap";
    const store = await seedRun(runId);
    const journal = new RunObservationJournal(store);
    await expect(journal.observe("rn-missing")).rejects.toBeInstanceOf(
      RunNotFoundError
    );
    await journal.publish(runId, { kind: "output", value: "discarded" });
    await journal.publish(runId, { kind: "output", value: "retained" });
    const listFrames = store.listRunFrames.bind(store);
    store.listRunFrames = async (id, after) =>
      (await listFrames(id, after)).filter((frame) => frame.cursor > 0);

    await expect(journal.observe(runId, { after: -1 })).rejects.toBeInstanceOf(
      RunReplayGapError
    );
  });

  test("rejects a cursor ahead of the durable journal", async () => {
    const runId = "rn-future-cursor";
    const store = await seedRun(runId);
    const journal = new RunObservationJournal(store);
    await journal.publish(runId, { kind: "output", value: "only" });

    await expect(journal.observe(runId, { after: 99 })).rejects.toBeInstanceOf(
      RunReplayGapError
    );
  });

  test.each([Number.NaN, -2, 0.5])(
    "rejects invalid cursor %s",
    async (after) => {
      const runId = "rn-invalid-cursor";
      const store = await seedRun(runId);
      const journal = new RunObservationJournal(store);
      await expect(journal.observe(runId, { after })).rejects.toBeInstanceOf(
        RangeError
      );
    }
  );
});

describe("Orchestrator.observe", () => {
  test("detach, finish, and reconnect replays missed output through terminal exactly once", async () => {
    const store = makeInMemoryStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    orchestrator.register<string, string>("streaming", (input, context) => {
      if (!context) {
        throw new Error("expected execution context");
      }
      return Workflow.create({
        execute: async (_value, stepContext) => {
          stepContext.log("info", "streaming started", { phase: 1 });
          await context.emitOutput({ delta: "first" });
          await runGate;
          await context.emitOutput({ delta: "second" });
          return "done";
        },
        input,
        name: "streaming",
      });
    });
    await orchestrator.start();
    const dispatched = await orchestrator.run("streaming", "input");
    const initial = await orchestrator.observe(dispatched.id);
    const iterator = initial[Symbol.asyncIterator]();
    let firstOutput: RunFrame | null = null;
    while (!firstOutput) {
      const next = await iterator.next();
      if (next.done) {
        throw new Error("observation ended before first output");
      }
      if (next.value.payload.kind === "output") {
        firstOutput = next.value;
      }
    }
    initial.close();

    releaseRun();
    await dispatched.result();
    const replay = await orchestrator.observe(dispatched.id, {
      after: firstOutput.cursor,
    });
    const missed = await collect(replay);
    const all = await store.listRunFrames(dispatched.id);

    expect(
      missed.filter((frame) => frame.payload.kind === "output")
    ).toMatchObject([{ payload: { value: { delta: "second" } } }]);
    expect(
      missed.filter(
        (frame) =>
          frame.payload.kind === "lifecycle" &&
          typeof frame.payload.value === "object" &&
          frame.payload.value !== null &&
          !Array.isArray(frame.payload.value) &&
          (frame.payload.value as Readonly<Record<string, unknown>>).status ===
            "complete"
      )
    ).toHaveLength(1);
    expect(new Set(all.map((frame) => frame.cursor)).size).toBe(all.length);
    expect(all.map((frame) => frame.cursor)).toEqual(
      all.map((_, cursor) => cursor)
    );
    expect(all.some((frame) => frame.payload.kind === "log")).toBe(true);
    expect(all.some((frame) => frame.payload.kind === "progress")).toBe(true);
    expect(
      all.filter(
        (frame) =>
          frame.payload.kind === "lifecycle" &&
          typeof frame.payload.value === "object" &&
          frame.payload.value !== null &&
          !Array.isArray(frame.payload.value) &&
          (frame.payload.value as Readonly<Record<string, unknown>>).event ===
            "started"
      )
    ).toMatchObject([{ payload: { value: { status: "running" } } }]);
    await orchestrator.stop();
  });

  test("publication failure rejects live observers and restart reconciles terminal state", async () => {
    const store = makeInMemoryStore();
    const appendFrame = store.appendRunFrame.bind(store);
    let failTerminalFrame = true;
    store.appendRunFrame = async (input) => {
      if (
        failTerminalFrame &&
        input.payload.kind === "lifecycle" &&
        typeof input.payload.value === "object" &&
        input.payload.value !== null &&
        !Array.isArray(input.payload.value) &&
        (input.payload.value as Readonly<Record<string, unknown>>).status ===
          "complete"
      ) {
        failTerminalFrame = false;
        throw new Error("terminal frame failed");
      }
      return appendFrame(input);
    };
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    orchestrator.register("terminal-failure", () =>
      Workflow.create({
        execute: async () => {
          await runGate;
          return "done";
        },
        input: null,
        name: "terminal-failure",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("terminal-failure", null);
    const observation = await orchestrator.observe(run.id);
    const frames = collect(observation);

    releaseRun();
    await run.result();
    await expect(frames).rejects.toThrow(/terminal frame failed/i);
    const retained = await store.listRunFrames(run.id);
    const after = retained.at(-1)?.cursor ?? -1;
    const restarted = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    const reconciled = await restarted.observe(run.id, { after });
    await expect(collect(reconciled)).resolves.toMatchObject([
      {
        payload: {
          kind: "lifecycle",
          value: { event: "complete", reconciled: true },
        },
      },
    ]);
    await restarted.stop();
    await orchestrator.stop();
  });

  test("terminal detection uses lifecycle event rather than status", async () => {
    const runId = "rn-terminal-event";
    const store = await seedRun(runId);
    const journal = new RunObservationJournal(store);
    const observation = await journal.observe(runId);
    const frames = collect(observation);

    await journal.publish(runId, {
      kind: "lifecycle",
      value: { event: "started", status: "cancelled" },
    });
    await journal.publish(runId, {
      kind: "lifecycle",
      value: { event: "cancelled", status: "cancelled" },
    });

    await expect(frames).resolves.toMatchObject([
      { payload: { value: { event: "started" } } },
      { payload: { value: { event: "cancelled" } } },
    ]);
  });

  test("terminal reconciliation and normal publication share one durable claim", async () => {
    const runId = "rn-terminal-claim";
    const store = await seedRun(runId);
    await store.updateRun(runId, { status: "complete" });
    const reconciling = new RunObservationJournal(store);
    const publishing = new RunObservationJournal(store);

    const [observation] = await Promise.all([
      reconciling.observe(runId),
      publishing.publish(runId, {
        kind: "lifecycle",
        value: { event: "complete", status: "complete" },
      }),
    ]);
    await collect(observation);
    const terminal = (await store.listRunFrames(runId)).filter((frame) =>
      frame.payload.kind === "lifecycle"
        ? (frame.payload.value as Readonly<Record<string, unknown>>).event ===
          "complete"
        : false
    );
    expect(terminal).toHaveLength(1);
  });

  test("clearQueue waits for an in-flight frame before deleting journal and Run", async () => {
    const store = new DelayedFrameStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    orchestrator.register("queued", () =>
      Workflow.create({
        execute: async () => "unexpected",
        input: null,
        name: "queued",
      })
    );
    await orchestrator.start();
    await orchestrator.pause();
    const run = await orchestrator.run("queued", null);
    await store.frameWriteEntered;
    let cleared = false;
    const clearing = orchestrator.clearQueue().then(() => {
      cleared = true;
    });
    await Promise.resolve();
    expect(cleared).toBe(false);

    store.releaseFrameWrite();
    await clearing;
    await expect(store.getRun(run.id)).resolves.toBeNull();
    const [queue] = await store.listQueues();
    if (!queue) {
      throw new Error("expected queue");
    }
    await store.createRun({
      id: run.id,
      input: null,
      queueId: queue.id,
      step: "recreated",
    });
    await expect(store.listRunFrames(run.id)).resolves.toEqual([]);
    await orchestrator.stop({ graceMs: 1 });
  });
});
