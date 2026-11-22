---
title: Take work in
description: Turn a GitHub issue into a task, and dispatch every ready task to the build stage.
---

Work enters the factory as a task tagged `factory`. You can create one by
hand, import a GitHub issue, or let a monitor or an MCP client add one. A
dispatcher observes the backlog and launches the build stage for each task
that is ready.

## Shared inputs

Every stage takes the task id as input, and the later stages add the
branch and commit. `brief` turns a task into the text the agents read,
including findings from an earlier attempt. Save it as
`.foundry/marbles/_factory/work.ts`:

<include>./_example/_factory/work.ts</include>

## The intake step and the dispatcher

Save this as `.foundry/marbles/factory.ts`:

<include>./_example/factory.ts</include>

`factory-import` reads an issue with `gh` and creates a task. Its
description keeps the issue body and URL, and its metadata keeps the issue
number, so importing the same issue twice returns the existing task.

`dispatchFactory` is the same dispatcher as in [the outer
loop](/marbles/get-started/outer-loop#write-the-loop). On every task change
it asks for ready `factory` tasks, claims each one atomically, and launches
`factory-build` with its id. A claim checks both the task's token and its
readiness, so two passes, or two processes, never start the same task.
Dependencies work as they do anywhere else: a task that depends on another
waits until that one settles.

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

`factory.ts` imports the build stage, which imports the rest, so the
module loads only once all six files exist. Save the files from the next
four pages before attaching the workspace. Then open `marbles`, create a task, and watch `factory-build`
appear in the Runs panel.

Next: [Plan and build](/marbles/use-cases/software-factory/build).
