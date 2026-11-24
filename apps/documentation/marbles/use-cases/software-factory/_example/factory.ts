import { observe, step, TaskError, tasks } from "@foundry.sh/marbles";
import { z } from "zod";
import { build } from "./_factory/build";

const issue = z.object({
  body: z.string(),
  title: z.string(),
  url: z.string(),
});

async function findByIssue(issueNumber: number): Promise<string | undefined> {
  let cursor: number | undefined;
  do {
    const page = await tasks.list({
      ...(cursor === undefined ? {} : { cursor }),
      tags: { all: ["factory"] },
    });
    const existing = page.items.find(
      (candidate) => candidate.metadata.issue === issueNumber
    );
    if (existing) {
      return existing.id;
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

step("factory-import")
  .input(z.object({ issue: z.number().int().positive() }))
  .do(async ({ input, exec }) => {
    const existing = await findByIssue(input.issue);
    if (existing) {
      return { task: existing };
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
      try {
        await build.launch({ task: task.id });
      } catch (error) {
        await tasks.change({
          operations: [
            { kind: "task.set_status", status: "open", task: { id: task.id } },
          ],
        });
        throw error;
      }
    }
  }
});
