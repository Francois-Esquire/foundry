import { describe, expect, test } from "vitest";

import {
  InvalidRunFrameSequenceError,
  JobAlreadySettledError,
  JobAttemptAlreadyActiveError,
  RecordAlreadyExistsError,
} from "../errors";
import { ExecutionCoordinator } from "../index";
import type { RunFramePayload, RunRecord } from "../schema";
import type { WorkflowStore } from "../store/index";
import { MemoryWorkflowStore } from "../store/memory";
import { SqliteWorkflowStore } from "../store/sqlite";
import { libsqlDatabases } from "./helpers/sqlite";
import { orchestratorStoreContract } from "./helpers/store.contract";

/** What a store says to a call from inside its own transaction. */
const REENTRY = /ReentrantCallError.*use the view/;

const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

/** Fresh, empty storage of one kind. */
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
    /** Two coordinators sharing one store, as two engines on one database. */
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
        // The store it is handed is the way in.
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
        // The store enforces nothing; the coordinator refuses to read it.
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

/** What a snapshot export holds once read back: `JSON` in, `JSON` out. */
function validated(snapshot: unknown): unknown {
  return JSON.parse(JSON.stringify(snapshot));
}
