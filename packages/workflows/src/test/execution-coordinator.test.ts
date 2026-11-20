import { describe, expect, test } from "vitest";

import {
  InvalidRunFrameSequenceError,
  JobAlreadySettledError,
  JobAttemptAlreadyActiveError,
  RecordAlreadyExistsError,
} from "../errors";
import { ExecutionParticipants } from "../execution-participants";
import type { CreateRunInput } from "../index";
import { ExecutionCoordinator } from "../index";
import type { RunFramePayload, RunRecord } from "../schema";
import type { WorkflowStore } from "../store/index";
import { MemoryWorkflowStore } from "../store/memory";
import { SqliteWorkflowStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";
import { orchestratorStoreContract } from "./helpers/store.contract";

const REENTRY = /ReentrantCallError.*use the view/;

const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

type OpenStore = () => Promise<WorkflowStore>;

const STORES: readonly [string, OpenStore][] = [
  ["memory store", () => Promise.resolve(new MemoryWorkflowStore())],
  [
    "SQLite store (:memory:)",
    async () =>
      new SqliteWorkflowStore({ database: await memory.open(), scope: "s" }),
  ],
  [
    "SQLite store (file)",
    async () =>
      new SqliteWorkflowStore({ database: await files.open(), scope: "s" }),
  ],
];

for (const [name, open] of STORES) {
  orchestratorStoreContract(
    `ExecutionCoordinator over the ${name}`,
    async () => new ExecutionCoordinator({ store: await open() })
  );

  describe(`two ExecutionCoordinators over one ${name}`, () => {
    async function pair() {
      const store = await open();
      return {
        first: new ExecutionCoordinator({ store }),
        second: new ExecutionCoordinator({ store }),
        store,
      };
    }

    test("keep the first Queue put under overlap", async () => {
      const { first, second } = await pair();
      const [kept, other] = await Promise.all([
        first.ensureQueue({ id: "queue-race", name: "First" }),
        second.ensureQueue({ id: "queue-race", name: "Second" }),
      ]);

      expect(kept.name).toBe("First");
      expect(other).toStrictEqual(kept);
      expect(await second.listQueues()).toStrictEqual([kept]);
    });

    test("admit one of two Runs created under one id", async () => {
      const { first, second } = await pair();
      const outcomes = await Promise.allSettled([
        first.createRun({
          id: "rn-race",
          input: "first",
          queueId: "q",
          step: "s",
        }),
        second.createRun({
          id: "rn-race",
          input: "second",
          queueId: "q",
          step: "s",
        }),
      ]);

      const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
      const loser = outcomes.find((outcome) => outcome.status === "rejected");
      expect(loser?.reason).toBeInstanceOf(RecordAlreadyExistsError);
      expect(await first.getRun("rn-race")).toStrictEqual(
        winner?.status === "fulfilled" ? winner.value : undefined
      );
    });

    test("claim one managed attempt of a Job, and refuse the other", async () => {
      const { first, second } = await pair();
      const job = await first.createJob({
        definition: { name: "documents.generate" },
        id: "jb-race",
        input: null,
      });
      const outcomes = await Promise.allSettled(
        [first, second].map((coordinator, index) =>
          coordinator.claimJobRun(job.id, {
            id: `rn-attempt-${index}`,
            input: null,
            queueId: "q",
            step: "documents.generate",
          })
        )
      );

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(
        outcomes.find((outcome) => outcome.status === "rejected")?.reason
      ).toBeInstanceOf(JobAttemptAlreadyActiveError);
      expect((await first.listRuns({ links: { jobId: job.id } })).total).toBe(
        1
      );
    });

    test("cancel a Job together with the attempt another claimed", async () => {
      const { first, second } = await pair();
      const job = await first.createJob({
        definition: { name: "documents.generate" },
        input: null,
      });
      const { run } = await first.claimJobRun(job.id, {
        input: null,
        queueId: "q",
        step: "documents.generate",
      });

      const cancellation = await second.cancelJob(job.id);

      expect(cancellation.job.status).toBe("cancelled");
      expect(cancellation.run?.id).toBe(run.id);
      expect(await first.getRun(run.id)).toMatchObject({
        status: "cancelled",
      });
    });

    test("keep one terminal frame and every concurrent output", async () => {
      const { first, second } = await pair();
      const run = await first.createRun({
        input: null,
        queueId: "q",
        step: "s",
      });
      const terminal: RunFramePayload = {
        kind: "lifecycle",
        value: { event: "complete" },
      };
      const [kept, again, output] = await Promise.all([
        first.appendRunFrame({ at: 1, payload: terminal, runId: run.id }),
        second.appendRunFrame({
          at: 2,
          payload: { kind: "lifecycle", value: { by: "b", event: "complete" } },
          runId: run.id,
        }),
        second.appendRunFrame({
          at: 3,
          payload: { kind: "output", value: "concurrent" },
          runId: run.id,
        }),
      ]);

      expect(again).toStrictEqual(kept);
      const frames = await first.listRunFrames(run.id);
      expect(frames.map((frame) => frame.cursor)).toEqual([0, 1]);
      expect(frames).toStrictEqual([kept, output]);
    });

    test("keep one effect claim per key", async () => {
      const { first, second } = await pair();
      const run = await first.createRun({
        input: null,
        queueId: "q",
        step: "s",
      });
      const claims = await Promise.all([
        first.claimRunEffect({
          key: "model-segment-0",
          metadata: { process: "first" },
          runId: run.id,
        }),
        second.claimRunEffect({
          key: "model-segment-0",
          metadata: { process: "second" },
          runId: run.id,
        }),
      ]);

      expect(claims.filter((frame) => frame !== null)).toHaveLength(1);
      expect(await second.listRunFrames(run.id)).toHaveLength(1);
    });
  });

  describe(`ExecutionCoordinator rules over the ${name}`, () => {
    test("takes every command's input as it stands when the command is called", async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      await coordinator.ensureQueue({ id: "q", name: "q" });
      const mutate = <T extends object>(
        value: T,
        change: (value: T) => void
      ) => {
        change(value);
        return value;
      };

      const queueInput = {
        extensions: { "host.q": { v: 1 } },
        id: "q2",
        name: "kept",
      };
      const queue = coordinator.ensureQueue(queueInput);
      mutate(queueInput, (value) => {
        value.name = "changed";
        value.extensions["host.q"].v = 2;
      });
      const jobInput = {
        definition: { name: "kept" },
        id: "jb-own",
        input: { v: "kept" },
        links: { sessionId: "kept" },
      };
      const job = coordinator.createJob(jobInput);
      mutate(jobInput, (value) => {
        value.definition.name = "changed";
        value.input.v = "changed";
        value.links.sessionId = "changed";
      });
      const runInput = {
        id: "rn-own",
        input: { v: "kept" },
        metadata: { list: ["kept"] },
        queueId: "q",
        step: "kept",
      };
      const created = coordinator.createRun(runInput);
      mutate(runInput, (value) => {
        value.step = "changed";
        value.input.v = "changed";
        value.metadata.list.push("changed");
        value.id = "rn-other";
      });
      await Promise.all([queue, job, created]);

      const patch = { output: { v: "kept" }, tags: { kept: "yes" } };
      const updated = coordinator.updateRun("rn-own", patch);
      mutate(patch, (value) => {
        value.output.v = "changed";
        value.tags.kept = "no";
      });
      const append = {
        payload: { kind: "output" as const, value: { v: "kept" } },
        runId: "rn-own",
      };
      const appended = coordinator.appendRunFrame(append);
      mutate(append, (value) => {
        value.runId = "rn-missing";
        value.payload.value.v = "changed";
      });
      const park = {
        kind: "approval",
        name: "approve",
        reason: "kept",
        request: { v: "kept" },
        runId: "rn-own",
        stepPath: ["kept"],
      };
      const parked = coordinator.parkSuspension(park);
      mutate(park, (value) => {
        value.reason = "changed";
        value.request.v = "changed";
        value.stepPath.push("changed");
      });
      await Promise.all([updated, appended, parked]);

      expect(
        (await coordinator.listQueues()).find((q) => q.id === "q2")
      ).toMatchObject({ extensions: { "host.q": { v: 1 } }, name: "kept" });
      expect(await coordinator.getJob("jb-own")).toMatchObject({
        definition: { name: "kept" },
        input: { v: "kept" },
        links: { sessionId: "kept" },
      });
      expect(await coordinator.getRun("rn-other")).toBeNull();
      expect(await coordinator.getRun("rn-own")).toMatchObject({
        input: { v: "kept" },
        metadata: { list: ["kept"] },
        output: { v: "kept" },
        status: "suspended",
        step: "kept",
        tags: { kept: "yes" },
      });
      expect(
        (await coordinator.listRunFrames("rn-own")).map(
          (frame) => frame.payload
        )
      ).toStrictEqual([{ kind: "output", value: { v: "kept" } }]);
      expect(
        (await coordinator.listSuspensions({ runId: "rn-own" })).items
      ).toMatchObject([
        { reason: "kept", request: { v: "kept" }, stepPath: ["kept"] },
      ]);
    });

    test("refuses an argument whose fields a copy would not keep", async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      class RunInput {
        readonly input = null;
        readonly queueId = "q";
        get step() {
          return "s";
        }
      }
      const hidden = Object.defineProperty(
        { input: null, queueId: "q" },
        "step",
        { enumerable: false, value: "s" }
      );

      for (const input of [new RunInput(), hidden]) {
        await expect(
          coordinator.createRun(input as unknown as CreateRunInput)
        ).rejects.toThrow(
          "ExecutionCoordinator.createRun takes plain objects: argument 1"
        );
      }
      expect((await coordinator.listRuns({})).total).toBe(0);
    });

    test("admission keeps a Job its claim found settled, and refuses the claim once that commits", async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      const job = await coordinator.createJob({
        definition: { name: "documents.generate" },
        input: null,
      });
      const { run } = await coordinator.claimJobRun(job.id, {
        input: null,
        queueId: "q",
        step: "documents.generate",
      });
      await coordinator.updateRun(run.id, { status: "complete" });
      const admitted: string[] = [];
      const participants = new ExecutionParticipants(
        coordinator,
        ({ run: claimed }) => {
          admitted.push(claimed.id);
          return Promise.resolve(null);
        },
        undefined
      );

      await expect(
        participants.claim(job.id, {
          input: null,
          queueId: "q",
          step: "documents.generate",
        })
      ).rejects.toBeInstanceOf(JobAlreadySettledError);
      expect(await coordinator.getJob(job.id)).toMatchObject({
        status: "complete",
      });
      expect(admitted).toEqual([]);
      expect(
        (await coordinator.listRuns({ links: { jobId: job.id } })).total
      ).toBe(1);
    });

    test("rolls a transaction back whenever its work throws, a settled claim's refusal included", async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      const job = await coordinator.createJob({
        definition: { name: "documents.generate" },
        input: null,
      });
      const { run } = await coordinator.claimJobRun(job.id, {
        input: null,
        queueId: "q",
        step: "documents.generate",
      });
      await coordinator.updateRun(run.id, { status: "complete" });

      await expect(
        coordinator.transaction?.(async (bound) => {
          await bound.createRun({
            id: "rn-unrelated",
            input: null,
            queueId: "q",
            step: "s",
          });
          await bound.claimJobRun(job.id, {
            input: null,
            queueId: "q",
            step: "documents.generate",
          });
        })
      ).rejects.toBeInstanceOf(JobAlreadySettledError);
      expect(await coordinator.getRun("rn-unrelated")).toBeNull();
      expect(await coordinator.getJob(job.id)).toMatchObject({
        status: "active",
      });

      await expect(
        coordinator.transaction?.(async (bound) => {
          await bound.createRun({
            id: "rn-lost",
            input: null,
            queueId: "q",
            step: "s",
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      expect(await coordinator.getRun("rn-lost")).toBeNull();
    });

    test("states its store's durability, and a transaction's is host", async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      expect(coordinator.durability).toBe("commit");
      expect(
        await coordinator.transaction?.((bound) =>
          Promise.resolve(bound.durability)
        )
      ).toBe("host");
    });

    test("refuses a call to itself from inside its own transaction, at once", async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      const run = await coordinator.createRun({
        input: null,
        queueId: "q",
        step: "s",
      });

      const outcomes = await coordinator.transaction?.(async (bound) => {
        const settled = await Promise.allSettled([
          coordinator.getRun(run.id),
          coordinator.updateRun(run.id, { status: "running" }),
          coordinator.listRuns({}),
        ]);
        await bound.updateRun(run.id, { status: "running" });
        return settled;
      });

      expect(
        outcomes?.map((outcome) =>
          outcome.status === "rejected" ? String(outcome.reason) : "resolved"
        )
      ).toEqual(
        Array.from({ length: 3 }, () => expect.stringMatching(REENTRY))
      );
      expect(await coordinator.getRun(run.id)).toMatchObject({
        status: "running",
      });
    });

    test("keeps a Run whose id predates the rn- prefix", async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      const run = await coordinator.createRun({
        id: "legacy-1",
        input: null,
        queueId: "q",
        step: "s",
      });

      expect(await coordinator.getRun("legacy-1")).toStrictEqual(run);
      expect(
        await coordinator.updateRun("legacy-1", { status: "running" })
      ).toMatchObject({ id: "legacy-1", status: "running" });
    });

    test("settles a Job whose attempt completed, then refuses the claim", async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      const job = await coordinator.createJob({
        definition: { name: "documents.generate" },
        input: null,
      });
      const { run } = await coordinator.claimJobRun(job.id, {
        input: null,
        queueId: "q",
        step: "documents.generate",
      });
      await coordinator.updateRun(run.id, { status: "complete" });

      await expect(
        coordinator.claimJobRun(job.id, {
          input: null,
          queueId: "q",
          step: "documents.generate",
        })
      ).rejects.toBeInstanceOf(JobAlreadySettledError);
      expect(await coordinator.getJob(job.id)).toMatchObject({
        status: "complete",
      });
    });

    test("checks a Run's journal as one sequence when it reads or appends", async () => {
      const store = await open();
      const coordinator = new ExecutionCoordinator({ store });
      const run = await coordinator.createRun({
        input: null,
        queueId: "q",
        step: "s",
      });
      await expect(
        coordinator.appendRunFrame({
          payload: { kind: "output", value: undefined } as never,
          runId: run.id,
        })
      ).rejects.toThrow();

      const output = (cursor: number) => ({
        at: cursor + 1,
        cursor,
        payload: { kind: "output" as const, value: { cursor } },
        runId: run.id,
      });
      const terminal = (cursor: number, event: "complete" | "failed") => ({
        at: cursor + 1,
        cursor,
        payload: { kind: "lifecycle" as const, value: { event } },
        runId: run.id,
      });
      const invalid = [
        [output(0), output(2)],
        [terminal(0, "complete"), terminal(1, "failed")],
        [
          terminal(0, "complete"),
          { ...output(1), payload: { kind: "progress" as const, value: 1 } },
        ],
      ];
      for (const frames of invalid) {
        await store.commit({ deleteRunFrames: [run.id], putFrames: frames });
        await expect(coordinator.listRunFrames(run.id)).rejects.toBeInstanceOf(
          InvalidRunFrameSequenceError
        );
        await expect(
          coordinator.appendRunFrame({
            payload: { kind: "output", value: "must not append" },
            runId: run.id,
          })
        ).rejects.toBeInstanceOf(InvalidRunFrameSequenceError);
      }
    });

    test("keeps receipts and claims after the terminal frame, and nothing else", async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      const run = await coordinator.createRun({
        input: null,
        queueId: "q",
        step: "s",
      });
      const terminal = await coordinator.appendRunFrame({
        payload: { kind: "lifecycle", value: { event: "complete" } },
        runId: run.id,
      });
      await coordinator.claimRunEffect({ key: "settled", runId: run.id });
      await coordinator.appendRunFrame({
        payload: { kind: "output", value: { receipt: "cleared" } },
        runId: run.id,
      });
      expect(
        await coordinator.appendRunFrame({
          payload: { kind: "lifecycle", value: { event: "failed" } },
          runId: run.id,
        })
      ).toStrictEqual(terminal);
      for (const payload of [
        { kind: "lifecycle", value: { event: "running" } },
        { kind: "progress", value: 1 },
        { kind: "log", value: "late log" },
      ] as RunFramePayload[]) {
        await expect(
          coordinator.appendRunFrame({ payload, runId: run.id })
        ).rejects.toThrow();
      }
      expect(
        (await coordinator.listRunFrames(run.id)).map(
          (frame) => frame.payload.kind
        )
      ).toEqual(["lifecycle", "log", "output"]);
    });

    test("exports a snapshot that restores exactly, undeclared fields and __proto__ entries too", async () => {
      const source = new ExecutionCoordinator({ store: await open() });
      await source.ensureQueue({ id: "q", name: "q" });
      const created = await source.createRun({
        id: "rn-proto",
        input: { list: [1, "two", null] },
        metadata: JSON.parse('{"__proto__":{"kept":1},"plain":true}') as Record<
          string,
          unknown
        >,
        queueId: "q",
        step: "s",
        tags: JSON.parse('{"__proto__":"tag"}') as Record<string, string>,
      });
      await source.appendRunFrame({
        at: 5,
        payload: { kind: "output", value: { text: "retained" } },
        runId: created.id,
      });
      const exported = await source.snapshot();
      const withUndeclared = JSON.parse(
        JSON.stringify(exported).replace(
          '"id":"rn-proto"',
          '"id":"rn-proto","__proto__":{"undeclared":true},"archivedBy":"operator"'
        )
      ) as unknown;

      const target = new ExecutionCoordinator({ store: await open() });
      await target.restore(withUndeclared);
      const restored = (await target.getRun(created.id)) as RunRecord &
        Record<string, unknown>;

      expect(Object.hasOwn(restored, "__proto__")).toBe(true);
      expect(Object.hasOwn(restored, "archivedBy")).toBe(true);
      expect(Object.hasOwn(restored.metadata, "__proto__")).toBe(true);
      expect(Object.hasOwn(restored.tags, "__proto__")).toBe(true);
      expect(await target.snapshot()).toStrictEqual(validated(withUndeclared));
    });
  });
}

function validated(snapshot: unknown): unknown {
  return JSON.parse(JSON.stringify(snapshot));
}

describe("abandonRun", () => {
  const crashed = { message: "its process exited", name: "Interrupted" };

  for (const [name, open] of STORES) {
    test(`fails a queued or running Run once, and leaves any other, over the ${name}`, async () => {
      const coordinator = new ExecutionCoordinator({ store: await open() });
      const created = async (status: RunRecord["status"]) => {
        const run = await coordinator.createRun({
          input: null,
          queueId: "q",
          step: "s",
        });
        await coordinator.updateRun(run.id, { status });
        return run.id;
      };
      const queued = await created("queued");
      const running = await created("running");
      const parked = await created("suspended");
      const done = await created("complete");

      expect(await coordinator.abandonRun(running, crashed, 7)).toMatchObject({
        error: crashed,
        status: "failed",
        timestamps: { failedAt: 7 },
      });
      expect(await coordinator.abandonRun(queued, crashed, 8)).toMatchObject({
        status: "failed",
        timestamps: { failedAt: 8 },
      });
      expect(
        await coordinator.abandonRun(running, { message: "x", name: "X" }, 9)
      ).toMatchObject({ error: crashed, timestamps: { failedAt: 7 } });
      expect(await coordinator.abandonRun(parked, crashed)).toMatchObject({
        status: "suspended",
      });
      expect(await coordinator.abandonRun(done, crashed)).toMatchObject({
        status: "complete",
      });
      expect(await coordinator.abandonRun("rn-missing", crashed)).toBeNull();
    });
  }
});
