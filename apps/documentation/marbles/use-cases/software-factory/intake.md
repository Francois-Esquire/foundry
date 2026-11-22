---
title: Take work in
description: Turn a GitHub issue into a task, and dispatch every ready task to the build stage.
---

Work enters the factory as a task tagged `factory`. You can create one by
hand, import a GitHub issue, or let a monitor or an MCP client add one. A
dispatcher observes the backlog and launches `factory-change`, the build
and its verification, for each task that is ready.

## Shared inputs

Every stage takes the task id as input, and the later stages add the
branch and commit. `branchOf` names the task's branch, `factory/<task id>`.
`brief` turns a task into the text the agents read, including findings
from an earlier attempt. Save it as
`.foundry/marbles/_factory/work.ts`:

<include>./_example/_factory/work.ts</include>

## The intake step, the line, and the dispatcher

Save this as `.foundry/marbles/factory.ts`:

<include>./_example/factory.ts</include>

`factory-import` reads an issue with `gh` and creates a task. Its
description keeps the issue body and URL, and its metadata keeps the issue
number, so importing the same issue twice returns the existing task.

`factory-change` is the line one task runs down. It locks
`factory-verify` with the build as its `commit` child, so the build runs
first and verification starts from the commit it returns. [Verify in
parallel](/marbles/use-cases/software-factory/verify#the-tree) shows the
whole tree.

`dispatchFactory` is the same dispatcher as in [the outer
loop](/marbles/get-started/outer-loop#write-the-loop). On every task change
it asks for ready `factory` tasks, launches `factory-change` for each one,
and then claims it. The key, `factory-change:<task id>:attempt-<n>`, makes
one run per attempt. A redelivered change, a second pass, or a second
engine on the same workspace gets that run back instead of starting
another. `n` is the task's `attempts` metadata, which goes up each time
the task comes back, so a revision gets a fresh run. Dependencies work as
they do anywhere else: a task that depends on another waits until that one
settles.

## Write acceptance criteria into the task

The builder and the reviewer read the task's title and description. Write
what "done" means there:

```sh
marbles tasks create "Add --json to marbles status" --tag factory \
  --description "Acceptance: \`marbles status --json\` prints one JSON object. Existing text output is unchanged. A test covers both."
```

Or import an issue whose body has the criteria:

```sh
marbles roll factory-import --input '{"issue":42}'
```

A task that says "fix the bug" gets a builder that guesses. If the criteria
are missing, leave the task untagged until a person adds them.

## Run it

`factory.ts` imports the build and verify stages, which import the rest,
so the module loads only once all six files exist. Save the files from the
next four pages before attaching the workspace. Then open `marbles`, create
a task, and watch `factory-change` appear in the Runs panel, with the
build as its `commit` step and verification under `$workflow`.

Next: [Plan and build](/marbles/use-cases/software-factory/build).
