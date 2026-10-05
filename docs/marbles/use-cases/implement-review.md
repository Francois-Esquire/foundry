---
title: Implement–Review Loop
description: Give implementation and review separate turns, and hand the branch between them.
---

The repository example `apps/marbles/examples/development.ts` registers
`implement`, `review`, `develop-round`, `review-in-worktree`, and
`review-session` when loaded as the config. `develop-round` implements a task
in the working tree, then has a second agent review the uncommitted changes
against it; the reviewer's verdict comes back as findings.

```sh
marbles roll develop-round --config apps/marbles/examples/development.ts --dry-run \
  --input '{"task":"Add a --json flag to list"}'
```

Remove `--dry-run` to perform real model operations, in a checkout where you
intend the agent to make changes. The review parser accepts a standalone
`PASS` line as no findings. This is a model verdict; the example does not
independently prove verification passed.

## Compose your own round

This configuration keeps the implementation off your working tree by cutting
a worktree, and hands the branch, not the directory, to the review:

```ts
import { agent, step, workflow } from "@foundry/marbles";
import { z } from "zod";

const implementer = agent({ prompt: "Implement the requested change. Commit when done." });
const reviewer = agent({
  prompt: "Review without editing. Reply exactly PASS if satisfied; otherwise list findings.",
});

const implement = step("implement")
  .input(z.object({ task: z.string() }))
  .output(z.string())
  .do(({ input: { task }, agents, workspaces, run }) => {
    const branch = `task/${run.id.slice(3, 11)}`;
    return workspaces.current.git.withWorktree({ base: "main", branch }, async () => {
      const session = await agents.session(implementer);   // runs in the worktree
      await session.generate(task);
      return branch;
    });
  });

const review = step("review")
  .input(z.object({ task: z.string(), branch: z.string() }))
  .output(z.object({ branch: z.string(), findings: z.string(), passed: z.boolean() }))
  .do(({ input: { task, branch }, agents, workspaces }) =>
    workspaces.current.git.withWorktree({ base: branch }, async () => {
      const session = await agents.session(reviewer);
      const { text } = await session.generate(`Review branch ${branch} against main for this task: ${task}`);
      return { branch, findings: text, passed: text.trim() === "PASS" };
    })
  );

workflow("implement-and-review")
  .input(z.object({ task: z.string() }))
  .do(({ input: { task } }) => review({ branch: implement({}, { task }) }, { task }));
```

```sh
marbles roll implement-and-review --input '{"task":"Describe your task here"}'
```

`implement` returns its branch; `review` takes it as the child `branch` and
gets the task as a literal, so both arrive in its `input`. Each session opens
inside a worktree callback and runs there without being told. The worktree is
removed when the callback returns; the branch survives it.

Loops are not available yet. To run another round, launch the workflow again
with the findings appended to the task, from the dashboard or with `roll`.
Add an ordinary step that runs your verification command inside the worktree
and include its exit code in the result when passing tests must govern
completion; the [API reference](/marbles/reference/api#definitions) shows a
sandbox doing that.

For an independent review of any revision in a temporary checkout, add
`reviewInWorktree()` from `@foundry/marbles/prebuilt` to your config and run
`marbles roll review-in-worktree --input '{"repository":".","base":"main"}'`.
Worktree isolation is not a security sandbox.
