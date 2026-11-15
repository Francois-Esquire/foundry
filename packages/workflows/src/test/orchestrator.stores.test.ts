import { describe, expect, test } from "vitest";

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
  }
);
