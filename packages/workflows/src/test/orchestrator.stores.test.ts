import { describe, expect, test } from "vitest";

import { JobAlreadySettledError } from "../errors";
import type { RunQuery } from "../index";
import { ExecutionCoordinator } from "../index";
import { Orchestrator } from "../orchestrator";
import { bail } from "../types";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";
import { coordinatorStores } from "./helpers/coordinators";

/**
 * The runtime over every store: each way a Run ends is persisted, and the
 * store refuses none of the records the runtime writes on the way.
 */
describe.each(coordinatorStores())(
  "an Orchestrator over the %s",
  (_name, open) => {
    test("persists each way a Run ends, and the store refuses nothing", async () => {
      const { coordinator, failures } = await open();
      const orchestrator = new Orchestrator({
        config: makeOrchestratorConfig(),
        store: coordinator,
      });
      await orchestrator.setup();
      const outcomes: Record<string, () => Promise<unknown>> = {
        bailed: () => Promise.resolve(bail({ code: "declined" })),
        complete: () => Promise.resolve({ answer: [1, "two", null] }),
        "thrown error": () => Promise.reject(new Error("step failed")),
        "thrown value": () => Promise.reject("a plain string"),
      };
      for (const [name, execute] of Object.entries(outcomes)) {
        orchestrator.register(name, (input: null) =>
          Workflow.create({ execute, input, name })
        );
      }
      await orchestrator.start();

      try {
        const settled: Record<string, unknown> = {};
        for (const name of Object.keys(outcomes)) {
          const dispatched = await orchestrator.run(name, null, {
            links: { sessionId: undefined, subjectId: `subject-${name}` },
          });
          await dispatched.result().catch(() => undefined);
          await orchestrator.store
            .appendRunFrame({
              payload: { kind: "progress", value: 1 },
              runId: dispatched.id,
            })
            .catch(() => undefined);
          const stored = await orchestrator.getRun(dispatched.id);
          settled[name] = {
            error: stored?.error?.message ?? null,
            links: stored?.links,
            status: stored?.status,
          };
        }

        expect(settled).toEqual({
          bailed: {
            error: expect.any(String),
            links: { subjectId: "subject-bailed" },
            status: "failed",
          },
          complete: {
            error: null,
            links: { subjectId: "subject-complete" },
            status: "complete",
          },
          "thrown error": {
            error: "step failed",
            links: { subjectId: "subject-thrown error" },
            status: "failed",
          },
          "thrown value": {
            error: expect.any(String),
            links: { subjectId: "subject-thrown value" },
            status: "failed",
          },
        });
        expect(
          (await coordinator.snapshot()).runs.map((run) => run.status).sort()
        ).toEqual(["complete", "failed", "failed", "failed"]);
      } finally {
        await orchestrator.stop({ graceMs: 25 });
      }
      expect(failures).toEqual([]);
    });

    test("admission over a Job whose attempt completed leaves it complete, and refuses", async () => {
      const { failures, store } = await open();
      // The Job lifecycle settles a Job it sees finished before it claims.
      // Hiding finished Runs from it stands for a Run that finishes between
      // that look and the claim, so the claim inside admission finds it.
      class LateCompletion extends ExecutionCoordinator {
        override listRuns(query: RunQuery = {}) {
          return query.status === "complete"
            ? Promise.resolve({ items: [], total: 0 })
            : super.listRuns(query);
        }
      }
      const coordinator = new LateCompletion({ store });
      const admitted: string[] = [];
      const orchestrator = new Orchestrator({
        admissionParticipant: ({ run }) => {
          admitted.push(run.id);
          return Promise.resolve(null);
        },
        config: makeOrchestratorConfig(),
        store: coordinator,
      });
      await orchestrator.setup();
      orchestrator.register("settled", (input: null) =>
        Workflow.create({
          execute: () => Promise.resolve("done"),
          input,
          name: "settled",
        })
      );
      await orchestrator.start();
      try {
        const job = await orchestrator.createJob("settled", null);
        const [queue] = await coordinator.listQueues();
        const { run } = await coordinator.claimJobRun(job.id, {
          input: null,
          queueId: queue?.id ?? "q",
          step: "settled",
        });
        await coordinator.updateRun(run.id, { status: "complete" });

        await expect(orchestrator.execute(job.id)).rejects.toBeInstanceOf(
          JobAlreadySettledError
        );
        expect(await coordinator.getJob(job.id)).toMatchObject({
          status: "complete",
        });
        expect(admitted).toEqual([]);
      } finally {
        await orchestrator.stop({ graceMs: 25 });
      }
      expect(failures).toEqual([]);
    });
  }
);
