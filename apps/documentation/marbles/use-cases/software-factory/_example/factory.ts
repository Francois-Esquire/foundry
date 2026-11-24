import { observe, step, TaskError, tasks, workflow } from "@foundry.sh/marbles";
import { z } from "zod";
import { build } from "./_factory/build";
import { verify } from "./_factory/verify";
import { branchOf, workInput } from "./_factory/work";

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

const change = workflow("factory-change")
  .input(workInput)
  .do(({ input }) =>
    verify(
      { commit: build({}, input) },
      { branch: branchOf(input.task), task: input.task }
    )
  );

async function claim(id: string, updatedAt: string): Promise<void> {
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
  } catch (error) {
    if (
      error instanceof TaskError &&
      ["conflict", "not_ready"].includes(error.code)
    ) {
      return;
    }
    throw error;
  }
}

observe(tasks, async function dispatchFactory() {
  const ready = await tasks.ready({ tags: { all: ["factory"] } });
  for (const task of ready.items) {
    const attempt = Number(task.metadata.attempts ?? 0);
    await change.launch(
      { task: task.id },
      { key: `factory-change:${task.id}:attempt-${attempt}` }
    );
    await claim(task.id, task.updatedAt);
  }
});
