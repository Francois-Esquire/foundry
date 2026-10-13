---
title: Implement a task
description: Create a branch in a temporary worktree and capture the agent's committed result.
---

Start with the [walkthrough prerequisites](/marbles/use-cases/software-factory#before-you-start).
This stage creates a local branch. The agent edits and commits in a
temporary checkout; your current checkout stays on its existing branch.

## Define the implementation step

Create `.foundry/marbles/_factory/implement.ts`:

```ts
import { agent, step } from "@foundry/marbles";
import { z } from "zod";

export const changeSchema = z.object({
  branch: z.string(),
  base: z.string(),
  revision: z.string(),
});

const implementer = agent({
  name: "factory-implementer",
  prompt: "Implement the requested task with focused changes. Commit your changes. Do not push or merge.",
});

export const implement = step("factory-implement")
  .input(z.object({ task: z.string() }))
  .output(changeSchema)
  .do(async ({ input, agents, workspaces, exec, run }) => {
    const base = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim();
    const branch = `marbles/${run.id}`;
    return workspaces.current.git.withWorktree({ base, branch }, async () => {
      const session = await agents.session(implementer);
      await session.generate(input.task);
      const dirty = await exec(["git", "status", "--porcelain"]);
      if (dirty.stdout.trim()) {
        throw new Error("The agent left uncommitted changes; no candidate was accepted.");
      }
      const revision = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim();
      if (revision === base) {
        throw new Error("The agent made no commit; no candidate was produced.");
      }
      return { branch, base, revision };
    });
  });
```

The step captures the starting commit before opening the worktree. Its
session and commands inherit the temporary checkout's directory. The
result names an immutable commit as well as a branch, so later stages can
verify the same code even if the branch moves.

The checkout is a [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md)
resource; the conversation is an [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
session. The surrounding step records their result in the workflow.
Passing the commit SHA gives verification a durable code reference even
after the temporary checkout is removed.

The helper removes the worktree when its callback ends, including on
failure. Commits remain on the branch. Uncommitted work is not preserved by
this example, which is why the agent is instructed to commit and the step
checks its result.

The step has no retry policy: blindly retrying it can encounter the branch
already created by the failed attempt. If you add retries, first define
how to inspect or reuse that branch and any existing commit. See
[work that can repeat safely](/marbles/foundation/durability#design-work-that-can-repeat-safely).

## Make it launchable as a workflow

Create `.foundry/marbles/factory.ts`:

```ts
import { workflow } from "@foundry/marbles";
import { z } from "zod";
import { implement } from "./_factory/implement";

export const factory = workflow("factory")
  .input(z.object({ task: z.string() }))
  .do(({ input }) => implement({}, input));
```

## Run and verify

```sh
marbles list
marbles roll factory --input '{"task":"Clarify the setup instructions in README.md."}'
```

The result contains `branch`, `base`, and `revision`. Inspect the returned
commit with `git show <revision>` and confirm the branch exists with
`git branch --list 'marbles/*'`.

`marbles --dry-run list` checks that the module loads without invoking an
agent. Dry execution substitutes empty command output, so it cannot prove
this chapter's commit checks. Run the implementation only in a repository
where you want the task performed.

Continue with [Test and review](/marbles/use-cases/software-factory/verify).
