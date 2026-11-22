import {
  observe,
  runs,
  step,
  TaskError,
  tasks,
  workflow,
} from "@foundry.sh/marbles";
import { z } from "zod";

const checkTask = step("check-task")
  .input(z.object({ task: z.string() }))
  .do(async ({ input, exec }) => {
    const tests = await exec(["bun", "test"], { check: false });
    await tasks.update(input.task, { metadata: { exitCode: tests.exitCode } });
    await tasks.complete(input.task);
    return { exitCode: tests.exitCode };
  });

async function claim(id: string, updatedAt: string): Promise<boolean> {
  try {
    await tasks.change({
      operations: [
        {
          expectedUpdatedAt: updatedAt,
          kind: "task.set_status",
          requireReady: true,
          status: "active",
          task: { id },
        },
      ],
    });
    return true;
  } catch (error) {
    if (
      error instanceof TaskError &&
      ["conflict", "not_ready"].includes(error.code)
    ) {
      return false;
    }
    throw error;
  }
}

observe(tasks, async function dispatchChecks() {
  const ready = await tasks.ready({ tags: { all: ["checks"] } });
  for (const task of ready.items) {
    if (await claim(task.id, task.updatedAt)) {
      await checkTask.launch({ task: task.id });
    }
  }
});

observe(
  workflow,
  async function flagFailures({ runId }) {
    const run = await runs.get(runId);
    const input = run?.input as { task?: string } | undefined;
    const task = input?.task ? await tasks.get(input.task) : null;
    if (run?.name !== "check-task" || !task) {
      return;
    }
    await tasks.update(task.id, {
      metadata: { failure: run.error ?? "failed" },
      tags: ["needs-owner"],
    });
  },
  { types: ["run.failed"] }
);
