---
title: Composition
description: Build a definition once, lock it into a tree as often as needed.
---

A definition has two phases. Build: `step(name).input(schema).output(schema).do(fn)`
shapes it, and nothing is in a graph yet. Lock: calling it,
`review({}, { target: "." })`, makes one node with these children and this
literal input. One definition can be locked many times; each lock is its own
node.

## Hand a result to the next step

This module gives implementation and review separate agents and separate
turns. `implement` cuts a worktree and returns the branch it committed to;
`review` takes that branch as a child:

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
      const session = await agents.session(implementer);
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
marbles roll implement-and-review --dry-run --input '{"task":"Add a --json flag to list"}'
```

`review({ branch: implement(…) }, { task })` is children first, literal input
second. `implement` runs first; its result arrives in `review`'s
`input.branch`, and the literal `task` arrives beside it. `review`'s result is
the workflow's result. Drop `--dry-run` to perform real model operations, in a
checkout where you intend the agent to make changes.

The parent declares its children in `.input()` like any other input, and each
child's `.output()` is checked against its key when the module loads. A child
that does not fit, or a key the parent does not declare, is an error before
anything runs.

## Run independent work together

Children run in key order by default. `.parallel` runs them together. The
[Software Factory](/marbles/guides/software-factory) reviews the workspace
and runs its tests side by side, then hands both results to `publish`:

```ts
const weekly = workflow(
  "weekly",
  publish.parallel({
    findings: review({}, { target: "." }),
    exitCode: test({}),
  })
);
```

```text
weekly (publish)
├─ findings   review { target: "." }
└─ exitCode   test
```

| Call | Children run |
| --- | --- |
| `publish(children, input?)` | In key order. |
| `publish.series(children, input?)` | In key order, written out. |
| `publish.parallel(children, input?)` | Together. |

If a parallel sibling fails, the others are stopped and the run fails; if one
parks on a question, the others finish and the parent waits.

## The rules

- **Keys name steps.** `findings` and `exitCode` are the children's names in
  the dashboard, in logs, on resume, and in the parent's schema; the child
  shows as `weekly.findings`. Choose keys that read well.
- **Children and input merge.** Both land in the parent's `input`; a key in
  both is an error when the module loads.
- **Siblings are independent.** Data flows only from a child to its parent.
  A step that needs another's result takes it as a child, which is how a
  chain reads: `approve({ review: review({ branch: implement({}, { task }) }) })`.
- **A workflow is a name around a tree.** `workflow("weekly", tree)` makes a
  fixed tree launchable and schedulable. `workflow("ship").input(schema).do(setup)`
  builds the tree from input at launch. A workflow is a definition too:
  `weekly({})` locks it, which is what a monitor handler returns to start it.
- **A step can be one command.** `step("install").input(schema).exec("npm i
  $pkg")` runs the command with the input filling its placeholders, each
  one argument, never read by a shell; see the
  [API reference](/marbles/reference/api#the-builder).
- **A definition also runs on its own.** `review.run({ target: "." })`
  runs a step or workflow now and returns its output, inside a body or in
  a plain script. In a body it is recorded, so a replay returns the same
  output; prefer a child when the result should show as its own step.
- **Setup is not durable.** A workflow's `.do` receives `{ input, log, run }`
  and runs on every setup, including after a restart, so it prepares and
  returns the tree rather than doing work. Anything it must keep goes into a
  step as input, which the run records.

## Another round

Series and parallel are the two combinators today; race, branch, and loops
are [not available yet](/marbles/reference/api#not-available-yet). To run
another implement–review round, launch the workflow again with the findings
appended to the task, from the dashboard or with `roll`. When passing tests
must govern completion, add an ordinary step that runs the verification
command inside the worktree and include its exit code in the result.

The repository's `apps/marbles/examples/development.ts` is a larger version
of this module. Load it with `--source` to try it:

```sh
marbles roll develop-round --source apps/marbles/examples/development.ts --dry-run \
  --input '{"task":"Add a --json flag to list"}'
```

See the [API reference](/marbles/reference/api#locking-and-trees) for every
locking form.
