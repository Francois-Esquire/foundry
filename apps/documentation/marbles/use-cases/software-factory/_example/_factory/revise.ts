import { observe, runs, tasks, workflow } from "@foundry.sh/marbles";

const maxAttempts = 3;

export async function sendBack(id: string, findings: string): Promise<void> {
  const task = await tasks.get(id);
  if (!task) {
    return;
  }
  const attempts = Number(task.metadata.attempts ?? 0) + 1;
  if (attempts >= maxAttempts) {
    await tasks.update(id, {
      metadata: { attempts, findings },
      tags: ["needs-owner"],
    });
    return;
  }
  await tasks.change({
    operations: [
      {
        kind: "task.update",
        patch: { metadata: { attempts, findings } },
        task: { id },
      },
      { kind: "task.set_status", status: "open", task: { id } },
    ],
  });
}

observe(
  workflow,
  async function factoryFailures({ runId }) {
    const run = await runs.get(runId);
    const input = run?.input as { task?: string } | undefined;
    const task = input?.task ? await tasks.get(input.task) : null;
    if (!(run?.name.startsWith("factory-") && task)) {
      return;
    }
    if (task.metadata.failedRun === runId) {
      return;
    }
    await tasks.update(task.id, {
      metadata: {
        attempts: Number(task.metadata.attempts ?? 0) + 1,
        failedRun: runId,
        failure: `${run.name}: ${run.error ?? "failed"}`,
      },
      tags: ["needs-owner"],
    });
  },
  { types: ["run.cancelled", "run.failed"] }
);
