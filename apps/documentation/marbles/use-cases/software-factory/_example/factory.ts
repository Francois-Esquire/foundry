import { observe, step, TaskError, tasks } from "@foundry.sh/marbles";
import { z } from "zod";
import { build } from "./_factory/build";

const issue = z.object({
  body: z.string(),
  title: z.string(),
  url: z.string(),
});

step("factory-import")
  .input(z.object({ issue: z.number().int().positive() }))
  .do(async ({ input, exec }) => {
    const known = await tasks.list({ tags: { all: ["factory"] } });
    const existing = known.items.find(
      (candidate) => candidate.metadata.issue === input.issue
    );
    if (existing) {
      return { task: existing.id };
    }
    const view = await exec([
      "gh",
      "issue",
      "view",
      String(input.issue),
      "--json",
      "title,body,url",
    ]);
    const { body, title, url } = issue.parse(JSON.parse(view.stdout));
    const task = await tasks.create({
      description: `${body}\n\n${url}`,
      metadata: { issue: input.issue },
      tags: ["factory"],
      title,
    });
    return { task: task.id };
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

observe(tasks, async function dispatchFactory() {
  const ready = await tasks.ready({ tags: { all: ["factory"] } });
  for (const task of ready.items) {
    if (await claim(task.id, task.updatedAt)) {
      await build.launch({ task: task.id });
    }
  }
});
