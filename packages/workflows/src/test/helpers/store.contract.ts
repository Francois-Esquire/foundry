import { describe, expect, test } from "vitest";

import type {
  InMemoryOrchestratorStore,
  JsonValue,
  OrchestratorStore,
} from "../../store";

import {
  JobAlreadySettledError,
  JobAttemptAlreadyActiveError,
  JobNotFoundError,
  RecordAlreadyExistsError,
  RunAlreadySettledError,
  RunNotFoundError,
  StaleSuspensionRevisionError,
  SuspensionAlreadySettledError,
  SuspensionOccurrenceMismatchError,
} from "../../types";

export type StoreFactory = () => OrchestratorStore | Promise<OrchestratorStore>;

export function orchestratorStoreContract(
  name: string,
  makeStore: StoreFactory
): void {
  describe(`${name} OrchestratorStore contract`, () => {
    test("creates, queries, patches, clones, and deletes Jobs", async () => {
      const store = await makeStore();
      const input = { nested: { revision: 1 }, prompt: "draft" };
      const created = await store.createJob({
        definition: { name: "documents.generate", version: "1" },
        id: "jb-contract",
        input,
        links: { sessionId: "session-1", subjectId: "document-1" },
      });
      input.nested.revision = 2;

      await expect(
        store.createJob({
          definition: created.definition,
          id: created.id,
          input: null,
        })
      ).rejects.toBeInstanceOf(RecordAlreadyExistsError);
      await expect(store.getJob(created.id)).resolves.toMatchObject({
        input: { nested: { revision: 1 } },
      });
      expect(
        (
          await store.listJobs({
            definition: "documents.generate",
            links: { sessionId: "session-1" },
            status: "pending",
          })
        ).items
      ).toHaveLength(1);

      const completed = await store.updateJob(created.id, {
        status: "complete",
        timestamps: { completedAt: 42 },
      });
      expect(completed).toMatchObject({
        status: "complete",
        timestamps: { completedAt: 42 },
      });
      if (!completed) {
        throw new Error("expected completed Job");
      }
      (completed.input as { nested: { revision: number } }).nested.revision = 3;
      await expect(store.getJob(created.id)).resolves.toMatchObject({
        input: { nested: { revision: 1 } },
      });
      await expect(
        store.updateJob("jb-missing", { status: "failed" })
      ).resolves.toBeNull();

      await store.deleteJob(created.id);
      await expect(store.getJob(created.id)).resolves.toBeNull();
    });

    test("does not reopen terminal Jobs through stale projections", async () => {
      const store = await makeStore();
      for (const status of ["complete", "failed", "cancelled"] as const) {
        const job = await store.createJob({
          definition: { name: `terminal-${status}` },
          input: null,
        });
        await store.updateJob(job.id, { status });
        await expect(
          store.updateJob(job.id, { status: "pending" })
        ).resolves.toMatchObject({ status });
        await expect(store.getJob(job.id)).resolves.toMatchObject({ status });
      }
    });

    test("stores Run definitions and links and clones nested Run values", async () => {
      const store = await makeStore();
      await expect(
        store.createRun({
          input: null,
          links: { jobId: "jb-missing" },
          queueId: "main",
          step: "documents.generate",
        } as never)
      ).rejects.toThrow(/claimJobRun/);
      const job = await store.createJob({
        definition: { name: "documents.generate" },
        input: null,
      });
      const input = { nested: { revision: 1 } };
      const claim = await store.claimJobRun(job.id, {
        definition: { name: "documents.generate", version: "1" },
        input,
        links: { sessionId: "session-1" },
        queueId: "main",
        step: "documents.generate",
      });
      const run = claim.run;
      input.nested.revision = 2;

      expect(
        (
          await store.listRuns({
            definition: "documents.generate",
            links: { jobId: job.id, sessionId: "session-1" },
          })
        ).items
      ).toHaveLength(1);
      await expect(store.getRun(run.id)).resolves.toMatchObject({
        input: { nested: { revision: 1 } },
      });

      const updated = await store.updateRun(run.id, {
        metadata: { nested: { revision: 2 } },
      });
      if (!updated) {
        throw new Error("expected updated Run");
      }
      (updated.metadata.nested as { revision: number }).revision = 3;
      await expect(store.getRun(run.id)).resolves.toMatchObject({
        metadata: { nested: { revision: 2 } },
      });
    });

    test("atomically claims and retains a recoverable managed Job Run", async () => {
      const store = await makeStore();
      const job = await store.createJob({
        definition: { name: "documents.generate", version: "1" },
        input: { prompt: "draft" },
        links: { sessionId: "session-1", subjectId: "document-1" },
      });

      const claim = await store.claimJobRun(job.id, {
        definition: job.definition,
        id: "rn-job-contract",
        input: job.input,
        links: { sessionId: "session-1", subjectId: "document-1" },
        queueId: "main",
        step: "documents.generate",
      });
      expect(claim).toMatchObject({
        job: { id: job.id, status: "active" },
        run: {
          id: "rn-job-contract",
          links: {
            jobId: job.id,
            sessionId: "session-1",
            subjectId: "document-1",
          },
          status: "queued",
        },
      });

      await expect(
        store.claimJobRun(job.id, {
          id: "rn-job-contract-duplicate",
          input: job.input,
          queueId: "main",
          step: "documents.generate",
        })
      ).rejects.toBeInstanceOf(JobAttemptAlreadyActiveError);
      expect(
        (await store.listRuns({ links: { jobId: job.id } })).items
      ).toHaveLength(1);

      await expect(store.getRun(claim.run.id)).resolves.toMatchObject({
        links: { jobId: job.id },
        status: "queued",
      });
    });

    test("serializes concurrent Job Run claims without orphan rows", async () => {
      const store = await makeStore();
      const job = await store.createJob({
        definition: { name: "documents.generate" },
        input: null,
      });
      const makeClaim = (id: string) =>
        store.claimJobRun(job.id, {
          id,
          input: null,
          queueId: "main",
          step: "documents.generate",
        });

      const results = await Promise.allSettled([
        makeClaim("rn-claim-first"),
        makeClaim("rn-claim-second"),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(
        rejected?.status === "rejected" ? rejected.reason : null
      ).toBeInstanceOf(JobAttemptAlreadyActiveError);
      expect(
        (await store.listRuns({ links: { jobId: job.id } })).items
      ).toHaveLength(1);
    });

    test("rejects missing and settled Job claims without creating Runs", async () => {
      const store = await makeStore();
      await expect(
        store.claimJobRun("jb-missing", {
          input: null,
          queueId: "main",
          step: "documents.generate",
        })
      ).rejects.toBeInstanceOf(JobNotFoundError);

      const job = await store.createJob({
        definition: { name: "documents.generate" },
        input: null,
      });
      await store.updateJob(job.id, { status: "complete" });
      await expect(
        store.claimJobRun(job.id, {
          input: null,
          queueId: "main",
          step: "documents.generate",
        })
      ).rejects.toBeInstanceOf(JobAlreadySettledError);
      expect(
        (await store.listRuns({ links: { jobId: job.id } })).items
      ).toEqual([]);
    });

    test("creates, queries, settles, clones, and deletes Suspensions", async () => {
      const store = await makeStore();
      const run = await store.createRun({
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      await store.updateRun(run.id, { status: "suspended" });
      const request = { change: { id: "change-1" } };
      const suspension = await store.createSuspension({
        id: "su-contract",
        kind: "approval",
        name: "approve-change",
        reason: "Editor confirmation is required",
        request,
        runId: run.id,
        stepPath: ["generate", "apply"],
      });
      request.change.id = "mutated";

      await expect(
        store.createSuspension({
          id: suspension.id,
          kind: "input",
          name: "duplicate",
          reason: "duplicate",
          request: null,
          runId: run.id,
          stepPath: [],
        })
      ).rejects.toBeInstanceOf(RecordAlreadyExistsError);
      await expect(
        store.createSuspension({
          kind: "input",
          name: "missing",
          reason: "missing",
          request: null,
          runId: "rn-missing",
          stepPath: [],
        })
      ).rejects.toBeInstanceOf(RunNotFoundError);
      expect(
        (
          await store.listSuspensions({
            kind: "approval",
            name: "approve-change",
            runId: run.id,
            status: "pending",
          })
        ).items
      ).toMatchObject([{ request: { change: { id: "change-1" } } }]);

      await expect(
        store.settleSuspension(suspension.id, {
          expectedRevision: 1,
          outcome: { resolution: { allowed: true }, status: "resolved" },
        })
      ).rejects.toBeInstanceOf(StaleSuspensionRevisionError);
      await expect(store.getSuspension(suspension.id)).resolves.toMatchObject({
        revision: 0,
        status: "pending",
      });
      await expect(store.getRun(run.id)).resolves.toMatchObject({
        status: "suspended",
      });

      const settled = await store.settleSuspension(suspension.id, {
        expectedRevision: 0,
        outcome: { resolution: { allowed: true }, status: "resolved" },
        runPatch: { metadata: { resumed: true } },
      });
      expect(settled).toMatchObject({
        run: { metadata: { resumed: true }, status: "queued" },
        suspension: {
          resolution: { allowed: true },
          revision: 1,
          status: "resolved",
        },
      });
      (settled.suspension.resolution as { allowed: boolean }).allowed = false;
      await expect(store.getSuspension(suspension.id)).resolves.toMatchObject({
        resolution: { allowed: true },
      });
      await expect(
        store.settleSuspension(suspension.id, {
          expectedRevision: 1,
          outcome: { status: "cancelled" },
        })
      ).rejects.toBeInstanceOf(SuspensionAlreadySettledError);

      await store.deleteSuspension(suspension.id);
      await expect(store.getSuspension(suspension.id)).resolves.toBeNull();

      const cancelRun = await store.createRun({
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      await store.updateRun(cancelRun.id, { status: "suspended" });
      const cancelled = await store.createSuspension({
        kind: "input",
        name: "cancel-me",
        reason: "cancelled externally",
        request: null,
        runId: cancelRun.id,
        stepPath: ["generate"],
      });
      await expect(
        store.settleSuspension(cancelled.id, {
          expectedRevision: 0,
          outcome: { status: "cancelled" },
        })
      ).resolves.toMatchObject({
        run: { status: "cancelled" },
        suspension: { status: "cancelled" },
      });
    });

    test("parks one stable Suspension per occurrence address", async () => {
      const store = await makeStore();
      const run = await store.createRun({
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      const input = {
        kind: "approval",
        name: "approval",
        occurrence: 0,
        reason: "review",
        request: { revision: 1 },
        runId: run.id,
        stepPath: ["documents.generate", "apply"],
      } as const;

      const first = await store.parkSuspension(input);
      const replay = await store.parkSuspension(input);
      expect(first.created).toBe(true);
      expect(replay).toMatchObject({
        created: false,
        suspension: { id: first.suspension.id },
      });
      await expect(store.getRun(run.id)).resolves.toMatchObject({
        status: "suspended",
      });
      expect(
        (
          await store.listSuspensions({
            name: input.name,
            occurrence: input.occurrence,
            runId: run.id,
            stepPath: input.stepPath,
          })
        ).items
      ).toHaveLength(1);

      await expect(
        store.parkSuspension({
          ...input,
          request: { revision: 2 },
        })
      ).rejects.toBeInstanceOf(SuspensionOccurrenceMismatchError);
    });

    test("serializes concurrent parking at one occurrence address", async () => {
      const store = await makeStore();
      const run = await store.createRun({
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      const input = {
        kind: "approval",
        name: "approval",
        occurrence: 0,
        reason: "review",
        request: null,
        runId: run.id,
        stepPath: ["documents.generate"],
      } as const;

      const parked = await Promise.all([
        store.parkSuspension(input),
        store.parkSuspension(input),
      ]);
      expect(parked.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(parked.map((result) => result.suspension.id)).size).toBe(
        1
      );
      expect(
        (
          await store.listSuspensions({
            name: input.name,
            occurrence: input.occurrence,
            runId: run.id,
            stepPath: input.stepPath,
          })
        ).items
      ).toHaveLength(1);
    });

    test("atomically cancels a Run and every pending Suspension", async () => {
      const store = await makeStore();
      const run = await store.createRun({
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      const first = await store.parkSuspension({
        kind: "approval",
        name: "approval",
        occurrence: 0,
        reason: "first review",
        request: null,
        runId: run.id,
        stepPath: ["documents.generate"],
      });
      const second = await store.createSuspension({
        kind: "approval",
        name: "approval",
        occurrence: 1,
        reason: "second review",
        request: null,
        runId: run.id,
        stepPath: ["documents.generate"],
      });

      const cancellation = await store.cancelRunSuspensions(run.id, {
        metadata: { cancelledBy: "operator" },
      });
      expect(cancellation).toMatchObject({
        run: {
          metadata: { cancelledBy: "operator" },
          status: "cancelled",
        },
      });
      expect(cancellation.suspensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.suspension.id,
            revision: 1,
            status: "cancelled",
          }),
          expect.objectContaining({
            id: second.id,
            revision: 1,
            status: "cancelled",
          }),
        ])
      );
      expect(cancellation.suspensions).toHaveLength(2);
      expect(
        (await store.listSuspensions({ runId: run.id, status: "pending" }))
          .items
      ).toEqual([]);
      await expect(store.cancelRunSuspensions(run.id)).resolves.toMatchObject({
        run: { status: "cancelled" },
        suspensions: [],
      });
    });

    test("strict Run cancellation distinguishes missing and settled Runs", async () => {
      const store = await makeStore();
      await expect(store.cancelRun("rn-missing")).rejects.toBeInstanceOf(
        RunNotFoundError
      );

      const active = await store.createRun({
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      await expect(store.cancelRun(active.id)).resolves.toMatchObject({
        run: { status: "cancelled" },
      });
      await expect(store.cancelRun(active.id)).rejects.toBeInstanceOf(
        RunAlreadySettledError
      );

      const complete = await store.createRun({
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      await store.updateRun(complete.id, { status: "complete" });
      await expect(store.cancelRun(complete.id)).rejects.toBeInstanceOf(
        RunAlreadySettledError
      );
    });

    test("atomically cancels a Job execution aggregate", async () => {
      const store = await makeStore();
      const job = await store.createJob({
        definition: { name: "documents.generate" },
        input: null,
      });
      const claim = await store.claimJobRun(job.id, {
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      const parked = await store.parkSuspension({
        kind: "approval",
        name: "approval",
        occurrence: 0,
        reason: "review",
        request: null,
        runId: claim.run.id,
        stepPath: ["documents.generate"],
      });

      await expect(store.cancelJob(job.id)).resolves.toMatchObject({
        job: { id: job.id, status: "cancelled" },
        run: { id: claim.run.id, status: "cancelled" },
        suspensions: [
          { id: parked.suspension.id, revision: 1, status: "cancelled" },
        ],
      });
      await expect(store.getJob(job.id)).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(store.getRun(claim.run.id)).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(
        store.claimJobRun(job.id, {
          input: null,
          queueId: "main",
          step: "documents.generate",
        })
      ).rejects.toBeInstanceOf(JobAlreadySettledError);
      await expect(store.cancelJob(job.id)).rejects.toBeInstanceOf(
        JobAlreadySettledError
      );
      await expect(store.cancelJob("jb-missing")).rejects.toBeInstanceOf(
        JobNotFoundError
      );
    });

    test("appends monotonic frames, filters by cursor, and clones values", async () => {
      const store = await makeStore();
      const run = await store.createRun({
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      const first = await store.appendRunFrame({
        at: 10,
        payload: { kind: "output", value: { text: "first" } },
        runId: run.id,
      });
      const second = await store.appendRunFrame({
        at: 11,
        payload: { kind: "output", value: { text: "second" } },
        runId: run.id,
      });

      expect([first.cursor, second.cursor]).toEqual([0, 1]);
      (second.payload.value as { text: string }).text = "mutated";
      await expect(store.listRunFrames(run.id, 0)).resolves.toMatchObject([
        { cursor: 1, payload: { value: { text: "second" } } },
      ]);
      await expect(
        store.appendRunFrame({
          payload: { kind: "output", value: null },
          runId: "rn-missing",
        })
      ).rejects.toBeInstanceOf(RunNotFoundError);

      await store.deleteRunFrames(run.id);
      await expect(store.listRunFrames(run.id)).resolves.toEqual([]);
    });

    test("atomically keeps the first terminal frame", async () => {
      const store = await makeStore();
      const run = await store.createRun({
        input: null,
        queueId: "main",
        step: "documents.generate",
      });
      const [first, second] = await Promise.all([
        store.appendRunFrame({
          payload: {
            kind: "lifecycle",
            value: { event: "complete", source: "queue", status: "complete" },
          },
          runId: run.id,
        }),
        store.appendRunFrame({
          payload: {
            kind: "lifecycle",
            value: {
              event: "complete",
              source: "reconcile",
              status: "complete",
            },
          },
          runId: run.id,
        }),
      ]);

      expect(second).toEqual(first);
      await expect(store.listRunFrames(run.id)).resolves.toHaveLength(1);
      await expect(
        store.appendRunFrame({
          payload: { kind: "progress", value: 1 },
          runId: run.id,
        })
      ).rejects.toThrow();
      await store.appendRunFrame({
        payload: { kind: "output", value: { receipt: "settled" } },
        runId: run.id,
      });
      expect(
        await store.claimRunEffect({ key: "notify", runId: run.id })
      ).not.toBeNull();
      expect(
        await store.claimRunEffect({ key: "notify", runId: run.id })
      ).toBeNull();
      await expect(store.listRunFrames(run.id)).resolves.toHaveLength(3);
    });

    test("rejects non-JSON Job and Suspension data", async () => {
      const store = await makeStore();
      await expect(
        store.createJob({
          definition: { name: "invalid" },
          input: { promise: Promise.resolve() } as unknown as JsonValue,
        })
      ).rejects.toThrow();

      await expect(
        store.createRun({
          input: { map: new Map() },
          queueId: "main",
          step: "invalid",
        })
      ).rejects.toThrow(/plain objects/);

      const normalized = await store.createRun({
        input: undefined,
        metadata: { optional: undefined },
        queueId: "main",
        step: "no-input",
      });
      expect(normalized).toMatchObject({ input: null, metadata: {} });

      const run = await store.createRun({
        input: null,
        queueId: "main",
        step: "invalid",
      });
      await expect(
        store.createSuspension({
          kind: "input",
          name: "invalid",
          reason: "invalid",
          request: { map: new Map() } as unknown as JsonValue,
          runId: run.id,
          stepPath: [],
        })
      ).rejects.toThrow();
    });
  });
}

// Type-only pin: the reference adapter must remain usable wherever the
// interface is accepted.
export type InMemoryStorePin =
  InMemoryOrchestratorStore extends OrchestratorStore ? true : false;
